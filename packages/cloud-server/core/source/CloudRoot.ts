import {
	encodeBroadcast,
	encodeMessage,
	relayStoreMessage,
} from "@pulsify/core/protocol";
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
	type CloudEnvelope,
	type CloudGrant,
	type CloudRole,
	type CloudRoleMessage,
	type CloudRootUsage,
} from "@pulsify/cloud";
import type { CloudCaller } from "./auth.js";
import { errorResponse, jsonResponse, readJson } from "./http.js";
import type { CloudRootStorage } from "./storage.js";

/** One authenticated WebSocket, as seen by its root. */
export type CloudPeer = {
	readonly id: string;
	readonly subject: string;
	readonly envelope: CloudEnvelope;
	send(data: Uint8Array | string): void;
	close(code: number, reason: string): void;
};
/** The host owns the sockets; a hibernating host rebuilds peers on demand. */
export type CloudPeers = {
	get(id: string): CloudPeer | undefined;
	all(): Iterable<CloudPeer>;
};

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
	receive(
		peer: CloudPeer,
		data: Uint8Array | ArrayBuffer | string,
	): Promise<void> {
		if (data === CLOUD_PING) {
			safely(() => peer.send(CLOUD_PONG));
			return Promise.resolve();
		}
		return this.run(async () => {
			try {
				if (typeof data === "string") {
					const message = parseClientMessage(data);
					await this.unsubscribe(peer.id, message.docId);
				} else
					await this.frame(
						peer,
						data instanceof Uint8Array ? data : new Uint8Array(data),
					);
			} catch (error) {
				const reason = error instanceof Error ? error.message : "Invalid frame";
				safely(() => peer.close(1008, reason.slice(0, 120)));
				await this.forget(peer.id);
			}
		});
	}

	disconnect(connection: string): Promise<void> {
		return this.run(() => this.forget(connection));
	}

	/** The management API of this root: `grants` and `usage`. */
	handleRequest(
		action: "grants" | "usage",
		request: Request,
		caller: CloudCaller,
	): Promise<Response> {
		return this.run(async () => {
			try {
				if (action === "usage") return jsonResponse(await this.usage(caller));
				const url = new URL(request.url);
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
		const [grants, subscriptions] = await Promise.all([
			this.storage.loadGrants(),
			this.storage.loadSubscriptions(),
		]);
		this.setGrants(grants);
		const live = new Set(Array.from(this.peers.all(), (peer) => peer.id));
		const stale = new Set<string>();
		for (const { connection, docId, role } of subscriptions) {
			if (!live.has(connection)) {
				stale.add(connection);
				continue;
			}
			let documents = this.subscriptions.get(connection);
			if (!documents)
				this.subscriptions.set(connection, (documents = new Map()));
			documents.set(docId, role);
		}
		for (const connection of stale)
			await this.storage.deleteConnection(connection);
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
		if (kind === 1) {
			if (!role) {
				if (subscribed) await this.unsubscribe(peer.id, docId);
				sendRole(peer, docId, null);
				return fail("FORBIDDEN", `No access to ${docId}`);
			}
			await this.subscribe(peer.id, docId, role);
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

	private async subscribe(
		connection: string,
		docId: string,
		role: CloudRole,
	): Promise<void> {
		let documents = this.subscriptions.get(connection);
		if (!documents) this.subscriptions.set(connection, (documents = new Map()));
		if (documents.get(docId) === role) return;
		documents.set(docId, role);
		await this.storage.saveSubscription({ connection, docId, role });
	}

	private async unsubscribe(connection: string, docId: string): Promise<void> {
		const documents = this.subscriptions.get(connection);
		if (!documents?.delete(docId)) return;
		if (!documents.size) this.subscriptions.delete(connection);
		await this.storage.deleteSubscription(connection, docId);
	}

	private async forget(connection: string): Promise<void> {
		if (!this.subscriptions.delete(connection)) return;
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

	private assertManager(caller: CloudCaller, prefix: string): void {
		if (caller.kind === "user" && !canManage(this.role(caller.subject, prefix)))
			throw new CloudError(
				"FORBIDDEN",
				`Only an owner of ${prefix} can change its grants`,
			);
	}

	private async putGrant(
		caller: CloudCaller,
		grant: CloudGrant,
	): Promise<CloudGrant> {
		this.assertManager(caller, grant.prefix);
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
			const documents = this.subscriptions.get(peer.id);
			if (!documents) continue;
			for (const [docId, previous] of [...documents]) {
				const role = this.role(peer.subject, docId);
				if (role === previous) continue;
				sendRole(peer, docId, role ?? null);
				if (role) {
					await this.subscribe(peer.id, docId, role);
					continue;
				}
				await this.unsubscribe(peer.id, docId);
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
