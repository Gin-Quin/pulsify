import {
	createPresenceBudget,
	decodeMessage,
	encodeBroadcast,
	encodeMessage,
	encodePresenceLeave,
	PRESENCE_KIND,
	PulseError,
	relayPresenceFrame,
	relayStoreMessage,
} from "pulsify-core/protocol";
import {
	ANY_SUBJECT,
	assertDocumentOf,
	assertSubject,
	canManage,
	canWrite,
	CLOUD_PING,
	CLOUD_PONG,
	CloudError,
	compareGrants,
	covers,
	MAX_GRANTS_PER_ROOT,
	parseClientMessage,
	parseGrant,
	peekFrameHeader,
	roleFor,
	rootOf,
	type CloudFetchMessage,
	type CloudAction,
	type CloudEnvelope,
	type CloudGrant,
	type CloudRole,
	type CloudRoleMessage,
	type CloudRootUsage,
} from "pulsify-cloud";
import type { CloudCaller } from "./auth.js";
import { errorResponse, jsonResponse, readJson } from "./http.js";
import type { CloudRootStorage } from "./storage.js";

/** One authenticated WebSocket, as seen by its root. */
export type CloudPeer = {
	readonly id: string;
	readonly subject: string;
	readonly envelope: CloudEnvelope;
	/** The client has sent a presence frame, so it understands them. */
	readonly presence: boolean;
	/** Remember that for the life of the socket, hibernation included. */
	usePresence(): void;
	/** The subscriptions last kept with the socket: what a root that wakes up reads. */
	readonly subscriptions: ReadonlyMap<string, CloudRole>;
	/**
	 * Keep these with the socket instead, hibernation included. False when they
	 * do not fit: the previous ones stay, and the root stores the rest.
	 */
	keepSubscriptions(subscriptions: ReadonlyMap<string, CloudRole>): boolean;
	send(data: Uint8Array | string): void;
	close(code: number, reason: string): void;
};
/** The host owns the sockets; a hibernating host rebuilds peers on demand. */
export type CloudPeers = {
	get(id: string): CloudPeer | undefined;
	all(): Iterable<CloudPeer>;
};

type FetchState = {
	docId: string;
	cancelled: boolean;
	error?: Error;
	batch: number;
	resume?: (() => void) | undefined;
};

// Work/transport windows, not limits on the size of a requested subtree.
/** Bounds of `cloud.expire`: a minute to thirty days without sockets. */
export const MIN_EXPIRY_MS = 60_000;
export const MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
const FETCH_DOCUMENT_PAGE = 128;
const FETCH_BATCH_FRAMES = 64;
const FETCH_BATCH_BYTES = 1024 * 1024;
const FETCH_ACK_TIMEOUT_MS = 30_000;

/**
 * A session's presence peer number. Derived from the connection ID, so it
 * survives hibernation, needs no storage, and is still known when the socket
 * is gone and its departure must be announced.
 */
export function presencePeer(connection: string): number {
	let high = 0x811c9dc5;
	let low = 0x9e3779b9;
	for (let i = 0; i < connection.length; i++) {
		const unit = connection.charCodeAt(i);
		high = Math.imul(high ^ unit, 16777619);
		low = Math.imul(low ^ unit, 2246822519);
	}
	// 48 bits, never zero: zero means "everyone" in a presence frame.
	return (high >>> 0) * 65536 + (low >>> 16) + 1;
}

/**
 * The runtime-independent state machine of one root: its documents, its
 * access table and the subscriptions of its connected users. Every event is
 * processed in order, like in a Durable Object.
 */
export class CloudRoot {
	private grants: CloudGrant[] | undefined;
	private bySubject = new Map<string, CloudGrant[]>();
	/** connection → document → role last sent to that connection. */
	private readonly subscriptions = new Map<string, Map<string, CloudRole>>();
	/** connection → documents whose subscription did not fit with the socket and is in storage. */
	private readonly stored = new Map<string, Set<string>>();
	/** What each connection may still send this second; lost on hibernation. */
	private readonly presenceBudgets = new Map<string, () => boolean>();
	private readonly fetches = new Map<string, Map<number, FetchState>>();
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		readonly root: string,
		private readonly storage: CloudRootStorage,
		private readonly peers: CloudPeers,
	) {}

	roleOf(subject: string, docId: string): Promise<CloudRole | undefined> {
		return this.run(async () => this.role(subject, docId));
	}

	/** Handle one WebSocket message; protocol violations close the socket. */
	async receive(
		peer: CloudPeer,
		data: Uint8Array | ArrayBuffer | string,
	): Promise<void> {
		if (data === CLOUD_PING) {
			safely(() => peer.send(CLOUD_PONG));
			return Promise.resolve();
		}
		try {
			if (typeof data === "string") {
				const message = parseClientMessage(data);
				// The handler stays alive, but never holds the root queue while
				// waiting for the network. Other events run between fetch windows.
				if (message.type === "fetch") {
					await this.fetchDocuments(peer, message);
					return;
				}
				await this.run(async () => {
					if (message.type === "unsubscribe")
						await this.unsubscribe(peer, message.docId);
					else {
						const fetch = this.fetches.get(peer.id)?.get(message.requestId);
						if (!fetch) return; // Late acknowledgement/cancellation.
						if (message.type === "cancel-fetch") fetch.cancelled = true;
						else if (message.batch !== fetch.batch || !fetch.resume)
							throw new CloudError(
								"BAD_REQUEST",
								"Unexpected fetch acknowledgement",
							);
						fetch.resume?.();
					}
				});
			} else
				await this.run(() =>
					this.frame(
						peer,
						data instanceof Uint8Array ? data : new Uint8Array(data),
					),
				);
		} catch (error) {
			await this.run(async () => {
				const reason = error instanceof Error ? error.message : "Invalid frame";
				safely(() => peer.close(1008, reason.slice(0, 120)));
				await this.forget(peer);
			});
		}
	}

	disconnect(peer: CloudPeer): Promise<void> {
		return this.run(() => {
			// A host may stop listing a socket before it reports that it closed.
			this.adopt(peer);
			return this.forget(peer);
		});
	}

	/** The management API of this root: `grants`, `usage`, `documents` and `expire`. */
	handleRequest(
		action: Exclude<CloudAction, "connect">,
		request: Request,
		caller: CloudCaller,
	): Promise<Response> {
		return this.run(async () => {
			try {
				if (action === "usage") return jsonResponse(await this.usage(caller));
				if (action === "expire") {
					if (request.method !== "PUT")
						throw new CloudError("METHOD_NOT_ALLOWED", "Use PUT");
					return jsonResponse({
						idleMs: await this.expire(caller, await readJson(request)),
					});
				}
				const url = new URL(request.url);
				if (action === "documents") {
					if (request.method !== "DELETE")
						throw new CloudError("METHOD_NOT_ALLOWED", "Use DELETE");
					const docId = url.searchParams.get("docId");
					assertDocumentOf(this.root, docId);
					return jsonResponse({
						deleted: await this.deleteDocuments(caller, docId),
					});
				}
				switch (request.method) {
					case "GET":
						return jsonResponse({ grants: this.visibleGrants(caller, url) });
					case "PUT": {
						const grant = await this.putGrant(
							caller,
							parseGrant(this.root, await readJson(request)),
						);
						return jsonResponse({ grant });
					}
					case "DELETE": {
						const subject = url.searchParams.get("subject");
						const prefix = url.searchParams.get("prefix");
						assertSubject(subject);
						assertDocumentOf(this.root, prefix);
						return jsonResponse({
							removed: await this.deleteGrant(caller, subject, prefix),
						});
					}
					default:
						throw new CloudError(
							"METHOD_NOT_ALLOWED",
							"Use GET, PUT or DELETE",
						);
				}
			} catch (error) {
				return errorResponse(error);
			}
		});
	}

	private run<T>(work: () => Promise<T>): Promise<T> {
		const result = this.queue.then(async () => {
			await this.load();
			return work();
		});
		this.queue = result.catch(() => {});
		return result;
	}

	private async load(): Promise<void> {
		if (this.grants) return;
		const [grants, stored] = await Promise.all([
			this.storage.loadGrants(),
			this.storage.loadSubscriptions(),
		]);
		this.setGrants(grants);
		const live = new Set<string>();
		for (const peer of this.peers.all()) {
			live.add(peer.id);
			this.adopt(peer);
		}
		const stale = new Set<string>();
		const gone: [connection: string, docId: string][] = [];
		for (const { connection, docId, role } of stored) {
			if (!live.has(connection)) {
				stale.add(connection);
				gone.push([connection, docId]);
				continue;
			}
			let documents = this.subscriptions.get(connection);
			if (!documents)
				this.subscriptions.set(connection, (documents = new Map()));
			documents.set(docId, role);
			const overflow = this.stored.get(connection);
			if (overflow) overflow.add(docId);
			else this.stored.set(connection, new Set([docId]));
		}
		for (const connection of stale)
			await this.storage.deleteConnection(connection);
		// Sockets that closed while the root slept left without a goodbye.
		for (const [connection, docId] of gone) this.leave(connection, docId);
	}

	/** Take the subscriptions a socket kept while its root was not there to know them. */
	private adopt(peer: CloudPeer): void {
		if (peer.subscriptions.size && !this.subscriptions.has(peer.id))
			this.subscriptions.set(peer.id, new Map(peer.subscriptions));
	}

	/** Keep with the socket every subscription of it that is not in storage. */
	private keep(peer: CloudPeer, documents: Map<string, CloudRole>): boolean {
		const stored = this.stored.get(peer.id);
		return peer.keepSubscriptions(
			stored
				? new Map([...documents].filter(([docId]) => !stored.has(docId)))
				: documents,
		);
	}

	/** The other sockets of a document that use presence. */
	private *presencePeers(
		docId: string,
		except: string,
	): Generator<CloudPeer, void> {
		for (const [connection, documents] of this.subscriptions) {
			if (connection === except || !documents.has(docId)) continue;
			const other = this.peers.get(connection);
			if (other?.presence) yield other;
		}
	}

	/** Presence is never stored: a session that leaves a document is announced. */
	private leave(connection: string, docId: string): void {
		const frame = encodePresenceLeave(docId, presencePeer(connection));
		for (const other of this.presencePeers(docId, connection))
			safely(() => other.send(frame));
	}

	/** Forward a presence frame to the document's other sessions, or to the one it answers. */
	private presence(peer: CloudPeer, bytes: Uint8Array): void {
		const { docId, frame, to } = relayPresenceFrame(bytes, {
			peer: presencePeer(peer.id),
			subject: peer.subject,
		});
		if (!peer.presence) peer.usePresence();
		let budget = this.presenceBudgets.get(peer.id);
		if (!budget)
			this.presenceBudgets.set(peer.id, (budget = createPresenceBudget()));
		// A session over its budget is not an error: frames are dropped.
		if (!budget()) return;
		for (const other of this.presencePeers(docId, peer.id))
			if (!to || to === presencePeer(other.id)) safely(() => other.send(frame));
	}

	private setGrants(grants: CloudGrant[]): void {
		this.grants = grants;
		this.bySubject = new Map();
		for (const grant of grants) {
			const list = this.bySubject.get(grant.subject);
			if (list) list.push(grant);
			else this.bySubject.set(grant.subject, [grant]);
		}
	}

	private role(subject: string, docId: string): CloudRole | undefined {
		return roleFor(
			[
				...(this.bySubject.get(subject) ?? []),
				...(this.bySubject.get(ANY_SUBJECT) ?? []),
			],
			subject,
			docId,
		);
	}

	/** Initial data prefetch only: live subscriptions are still explicit per document. */
	private async fetchDocuments(
		peer: CloudPeer,
		input: CloudFetchMessage,
	): Promise<void> {
		const { docId, requestId } = input;
		const state: FetchState = { docId, cancelled: false, batch: 0 };
		let registered = false;
		const check = async () => {
			if (!this.peers.get(peer.id)) state.cancelled = true;
			if (state.cancelled) throw new PulseError("CLOSED", "Fetch cancelled");
			if (state.error) throw state.error;
			// Recheck before every read/send after yielding to deletion or grants.
			if (!this.role(peer.subject, docId))
				throw new CloudError("FORBIDDEN", "No access to document");
			if (await this.storage.isDeleted(docId))
				throw new CloudError("NOT_FOUND", "Document was permanently deleted");
		};
		let frames = 0,
			bytes = 0;
		const flush = async () => {
			if (!frames) return;
			let acknowledged: Promise<void> = Promise.resolve();
			await this.run(async () => {
				await check();
				acknowledged = new Promise<void>((resolve) => {
					const timer = setTimeout(() => {
						state.error = new PulseError(
							"TIMEOUT",
							"Fetch acknowledgement timed out",
						);
						state.resume?.();
					}, FETCH_ACK_TIMEOUT_MS);
					state.resume = () => {
						clearTimeout(timer);
						state.resume = undefined;
						resolve();
					};
				});
				peer.send(
					JSON.stringify({
						type: "fetch-batch",
						requestId,
						batch: ++state.batch,
					}),
				);
			});
			await acknowledged;
			frames = bytes = 0;
		};
		try {
			await this.run(async () => {
				assertDocumentOf(this.root, docId);
				await check();
				let active = this.fetches.get(peer.id);
				if (!active) this.fetches.set(peer.id, (active = new Map()));
				if (active.has(requestId))
					throw new CloudError("BAD_REQUEST", "Duplicate fetch request ID");
				active.set(requestId, state);
				registered = true;
			});
			const vectors = new Map(input.vectors);
			let ids = [docId],
				after = docId;
			for (;;) {
				for (const id of ids) {
					const result = await this.run(async () => {
						await check();
						if (id !== docId && (await this.storage.isDeleted(id))) return;
						sendRole(peer, id, this.role(peer.subject, id)!);
						return relayStoreMessage(
							this.storage.patches,
							encodeMessage({
								kind: 1,
								docId: id,
								requestId,
								vv: vectors.get(id) ?? [],
							}),
							{ docId: id, protocolVersion: peer.envelope },
						);
					});
					if (!result) continue;
					for (const frame of result.responses) {
						if (
							frames &&
							(frames >= FETCH_BATCH_FRAMES ||
								bytes + frame.byteLength > FETCH_BATCH_BYTES)
						)
							await flush();
						const sent = await this.run(async () => {
							await check();
							if (id !== docId && (await this.storage.isDeleted(id))) {
								// A partially sent child was deleted while the batch was
								// in flight. Discard that child, never retire its parent.
								peer.send(
									encodeMessage({
										kind: 6,
										docId: id,
										requestId,
										code: "NOT_FOUND",
										message: "Document was permanently deleted",
									}),
								);
								return false;
							}
							peer.send(frame);
							return true;
						});
						if (!sent) break;
						frames++;
						bytes += frame.byteLength;
						if (peekFrameHeader(frame).kind === 6) {
							const failure = decodeMessage(frame);
							if (
								failure.kind === 6 &&
								failure.code === "NOT_FOUND" &&
								id !== docId
							)
								break;
							return;
						}
					}
				}
				if (!input.descendants) break;
				ids = await this.run(async () => {
					await check();
					return this.storage.patches.documents(
						docId,
						after,
						FETCH_DOCUMENT_PAGE,
					);
				});
				if (!ids.length) break;
				after = ids.at(-1)!;
			}
			await this.run(async () => {
				await check();
				peer.send(
					JSON.stringify({ type: "fetched", requestId, complete: true }),
				);
			});
		} catch (error) {
			if (state.cancelled) return;
			const code =
				error instanceof CloudError
					? error.code
					: ((error as { code?: string })?.code ?? "CONNECTION_FAILED");
			safely(() =>
				peer.send(
					encodeMessage({
						kind: 6,
						docId,
						requestId,
						code,
						message: error instanceof Error ? error.message : "Fetch failed",
					}),
				),
			);
		} finally {
			state.resume?.();
			if (registered) {
				const active = this.fetches.get(peer.id)!;
				active.delete(requestId);
				if (!active.size) this.fetches.delete(peer.id);
			}
		}
	}
	private async frame(peer: CloudPeer, bytes: Uint8Array): Promise<void> {
		const { envelope, kind, docId, requestId } = peekFrameHeader(bytes);
		if (envelope > peer.envelope)
			throw new CloudError(
				"BAD_REQUEST",
				`Envelope ${envelope} was not negotiated`,
			);
		const fail = (code: string, message: string) => {
			const frame = encodeMessage({ kind: 6, docId, requestId, code, message });
			safely(() => peer.send(frame));
		};
		if (rootOf(docId) !== this.root)
			return fail("FORBIDDEN", `${docId} belongs to another root`);
		const role = this.role(peer.subject, docId);
		const subscribed = this.subscriptions.get(peer.id)?.has(docId) ?? false;
		if (kind === PRESENCE_KIND) {
			// Readers too: presence is not a write. Without a subscription the
			// frame is dropped: the client already got its FORBIDDEN.
			if (subscribed && role) this.presence(peer, bytes);
			return;
		}
		if (role && (await this.storage.isDeleted(docId))) {
			if (subscribed) await this.unsubscribe(peer, docId);
			return fail("NOT_FOUND", "Document was permanently deleted");
		}
		if (kind === 1) {
			if (!role) {
				if (subscribed) await this.unsubscribe(peer, docId);
				sendRole(peer, docId, null);
				return fail("FORBIDDEN", `No access to ${docId}`);
			}
			await this.subscribe(peer, docId, role);
			sendRole(peer, docId, role);
		} else if (!subscribed)
			return fail(
				"INVALID_MESSAGE",
				"Connect to the document before uploading",
			);
		else if (!role) return fail("FORBIDDEN", `No access to ${docId}`);
		const result = await relayStoreMessage(this.storage.patches, bytes, {
			docId,
			readOnly: !canWrite(role),
			protocolVersion: peer.envelope,
		});
		for (const frame of result.responses) safely(() => peer.send(frame));
		if (!result.broadcast) return;
		for (const [connection, documents] of this.subscriptions) {
			if (connection === peer.id || !documents.has(docId)) continue;
			const other = this.peers.get(connection);
			if (other)
				safely(() =>
					other.send(encodeBroadcast(docId, result.broadcast!, other.envelope)),
				);
		}
	}

	/**
	 * A subscription lives with its socket, which costs no storage. Only one
	 * that does not fit there is stored, and it stays stored until it ends.
	 */
	private async subscribe(
		peer: CloudPeer,
		docId: string,
		role: CloudRole,
	): Promise<void> {
		const connection = peer.id;
		let documents = this.subscriptions.get(connection);
		if (!documents) this.subscriptions.set(connection, (documents = new Map()));
		if (documents.get(docId) === role) return;
		documents.set(docId, role);
		let stored = this.stored.get(connection);
		if (!stored?.has(docId)) {
			if (this.keep(peer, documents)) return;
			if (!stored) this.stored.set(connection, (stored = new Set()));
			stored.add(docId);
		}
		await this.storage.saveSubscription({ connection, docId, role });
	}

	private async unsubscribe(peer: CloudPeer, docId: string): Promise<void> {
		const connection = peer.id;
		const documents = this.subscriptions.get(connection);
		if (!documents?.delete(docId)) return;
		if (!documents.size) this.subscriptions.delete(connection);
		this.leave(connection, docId);
		// Also for a stored one: the socket may hold an older copy of it.
		this.keep(peer, documents);
		const stored = this.stored.get(connection);
		if (!stored?.delete(docId)) return;
		if (!stored.size) this.stored.delete(connection);
		await this.storage.deleteSubscription(connection, docId);
	}

	private async forget(peer: CloudPeer): Promise<void> {
		const connection = peer.id;
		for (const fetch of this.fetches.get(connection)?.values() ?? []) {
			fetch.cancelled = true;
			fetch.resume?.();
		}
		this.presenceBudgets.delete(connection);
		const documents = this.subscriptions.get(connection);
		if (!documents) return;
		this.subscriptions.delete(connection);
		for (const docId of documents.keys()) this.leave(connection, docId);
		// A socket closed for a violation is still there until its close event.
		safely(() => peer.keepSubscriptions(new Map()));
		if (this.stored.delete(connection))
			await this.storage.deleteConnection(connection);
	}

	private visibleGrants(caller: CloudCaller, url: URL): CloudGrant[] {
		const subject = url.searchParams.get("subject");
		const prefix = url.searchParams.get("prefix");
		return this.grants!.filter(
			(grant) =>
				(caller.kind === "admin" ||
					grant.subject === caller.subject ||
					canManage(this.role(caller.subject, grant.prefix))) &&
				(subject === null || grant.subject === subject) &&
				(prefix === null || covers(prefix, grant.prefix)),
		).sort(compareGrants);
	}

	private assertManager(
		caller: CloudCaller,
		prefix: string,
		what = "change its grants",
	): void {
		if (caller.kind === "user" && !canManage(this.role(caller.subject, prefix)))
			throw new CloudError(
				"FORBIDDEN",
				`Only an owner of ${prefix} can ${what}`,
			);
	}

	/**
	 * Erase a document, its sub-documents and their grants. Their sessions end
	 * with `NOT_FOUND`, which stops the pulses instead of letting them upload
	 * the document again.
	 */
	private async deleteDocuments(
		caller: CloudCaller,
		docId: string,
	): Promise<number> {
		this.assertManager(caller, docId, "delete it");
		// Persist first: a failed delete must never tell clients to retire live data.
		const deleted = await this.storage.deleteDocuments(docId);
		for (const active of this.fetches.values())
			for (const fetch of active.values())
				if (covers(docId, fetch.docId)) {
					fetch.error = new CloudError(
						"NOT_FOUND",
						"Document was permanently deleted",
					);
					fetch.resume?.();
				}
		for (const peer of this.peers.all())
			for (const subscribed of [
				...(this.subscriptions.get(peer.id)?.keys() ?? []),
			]) {
				if (!covers(docId, subscribed)) continue;
				await this.unsubscribe(peer, subscribed);
				safely(() =>
					peer.send(
						encodeMessage({
							kind: 6,
							docId: subscribed,
							requestId: 0,
							code: "NOT_FOUND",
							message: `${subscribed} was deleted`,
						}),
					),
				);
			}
		this.setGrants(
			this.grants!.filter((grant) => !covers(docId, grant.prefix)),
		);
		return deleted;
	}

	/** `cloud.expire`: store how long the root may stay idle before it is erased. */
	private async expire(caller: CloudCaller, body: unknown): Promise<number> {
		this.assertManager(caller, this.root, "make it expire");
		const idleMs = (body as { idleMs?: unknown } | null)?.idleMs;
		if (
			typeof idleMs !== "number" ||
			!Number.isSafeInteger(idleMs) ||
			idleMs < MIN_EXPIRY_MS ||
			idleMs > MAX_EXPIRY_MS
		)
			throw new CloudError(
				"BAD_REQUEST",
				`idleMs must be a whole number of milliseconds from ${MIN_EXPIRY_MS} to ${MAX_EXPIRY_MS}`,
			);
		if (!this.storage.setExpiry)
			throw new CloudError("BAD_REQUEST", "This server does not expire roots");
		if (await this.storage.isDeleted(this.root))
			throw new CloudError("NOT_FOUND", "Document was permanently deleted");
		await this.storage.setExpiry(idleMs);
		return idleMs;
	}

	private async putGrant(
		caller: CloudCaller,
		grant: CloudGrant,
	): Promise<CloudGrant> {
		this.assertManager(caller, grant.prefix);
		if (await this.storage.isDeleted(grant.prefix))
			throw new CloudError("NOT_FOUND", "Document was permanently deleted");
		const others = this.grants!.filter(
			(other) =>
				other.subject !== grant.subject || other.prefix !== grant.prefix,
		);
		if (others.length >= MAX_GRANTS_PER_ROOT)
			throw new CloudError("LIMIT_EXCEEDED", "Too many grants in this root");
		await this.storage.putGrant(grant);
		this.setGrants([...others, grant]);
		await this.refreshRoles(grant.subject);
		return grant;
	}

	private async deleteGrant(
		caller: CloudCaller,
		subject: string,
		prefix: string,
	): Promise<boolean> {
		this.assertManager(caller, prefix);
		if (!(await this.storage.deleteGrant(subject, prefix))) return false;
		this.setGrants(
			this.grants!.filter(
				(grant) => grant.subject !== subject || grant.prefix !== prefix,
			),
		);
		await this.refreshRoles(subject);
		return true;
	}

	/** Apply a grant change to live sessions: notify new roles, cut revoked documents. */
	private async refreshRoles(subject: string): Promise<void> {
		for (const peer of this.peers.all()) {
			if (subject !== ANY_SUBJECT && peer.subject !== subject) continue;
			for (const fetch of this.fetches.get(peer.id)?.values() ?? [])
				if (!this.role(peer.subject, fetch.docId)) {
					fetch.error = new CloudError(
						"FORBIDDEN",
						"Access to document was revoked",
					);
					fetch.resume?.();
				}
			const documents = this.subscriptions.get(peer.id);
			if (!documents) continue;
			for (const [docId, previous] of [...documents]) {
				const role = this.role(peer.subject, docId);
				if (role === previous) continue;
				sendRole(peer, docId, role ?? null);
				if (role) {
					await this.subscribe(peer, docId, role);
					continue;
				}
				await this.unsubscribe(peer, docId);
				safely(() =>
					peer.send(
						encodeMessage({
							kind: 6,
							docId,
							requestId: 0,
							code: "FORBIDDEN",
							message: `Access to ${docId} was revoked`,
						}),
					),
				);
			}
		}
	}

	private async usage(caller: CloudCaller): Promise<CloudRootUsage> {
		if (caller.kind !== "admin")
			throw new CloudError("FORBIDDEN", "Usage requires the API key");
		return {
			root: this.root,
			...(await this.storage.usage()),
			connections: Array.from(this.peers.all()).length,
		};
	}
}

function sendRole(peer: CloudPeer, docId: string, role: CloudRole | null) {
	const message: CloudRoleMessage = { type: "role", docId, role };
	safely(() => peer.send(JSON.stringify(message)));
}

function safely(action: () => void): void {
	try {
		action();
	} catch {
		// The socket is already closing; its close event cleans up.
	}
}
