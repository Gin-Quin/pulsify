import {
	openPulseSnapshot,
	type AnyPulseDefinition,
	type ModelFromDefinition,
	type Pulse,
	type PulseVersionVector,
} from "pulsify-core";
import type { CloudCredential } from "./client.js";
import { CloudError, isCloudErrorCode } from "./errors.js";
import { rootOf } from "./ids.js";
import type { CloudGrant } from "./roles.js";
import { cloudPath, type CloudAction } from "./wire.js";

/** Storage and connections of one root, from `usage` with the API key. */
export type CloudRootUsage = {
	root: string;
	documents: number;
	rows: number;
	bytes: number;
	connections: number;
};

/** A copy of a document that the server keeps as it was at `time`. */
export type CloudSnapshot = {
	id: string;
	docId: string;
	/** The server's clock when it made the copy, in milliseconds. */
	time: number;
	label?: string;
	/** The subject of the token that asked for it; absent with the API key. */
	subject?: string;
	/** The document's version vector at that moment. */
	version: PulseVersionVector;
};

/** A run of an actor's writes in a document, and the account whose connection sent them. */
export type CloudReceivedRange = {
	actor: number;
	/** The first sequence number of the run, and the one after its last. */
	clock: number;
	end: number;
	subject: string;
};
/** What a root recorded about who wrote a document, as `authors` receives it. */
export type CloudAuthorRecords = {
	/** The account each actor that wrote the document is bound to, if any. */
	actors: [actor: number, subject: string][];
	received: CloudReceivedRange[];
};
/** What the server knows of who wrote one transaction. */
export type CloudWriteAuthor = {
	/** The account the transaction's actor is bound to: what `actorSubject` answers. */
	subject?: string;
	/**
	 * The account whose connection sent the transaction to the server. It
	 * wrote it, or relayed it: a client also uploads what it received from
	 * others, offline or through another connector.
	 */
	receivedFrom?: string;
	/**
	 * Both are one account: it claimed the actor and sent the transaction
	 * itself. Otherwise the server cannot tell who wrote it.
	 */
	verified: boolean;
};
/** Who wrote a document, as the server knew it when `authors` was called. */
export type CloudAuthors = {
	/** The account each actor that wrote the document is bound to. */
	readonly actors: ReadonlyMap<number, string>;
	/** Who wrote a transaction: pass a version of `getPulseHistory`. */
	of(version: { actor: number; clock: number }): CloudWriteAuthor;
};

export type CloudClientOptions = {
	/** Base URL of the deployment, `https://…`. */
	url: string;
	/**
	 * The API key (server side only) or a user token. A user can list their own
	 * grants and manage the grants of every subtree they own.
	 */
	credential: CloudCredential;
	fetch?: typeof fetch;
};
export type CloudClient = {
	grants(
		root: string,
		filter?: { subject?: string; prefix?: string },
	): Promise<CloudGrant[]>;
	/** Create or replace the role of `subject` on `prefix`; applied to live sessions at once. */
	grant(grant: CloudGrant): Promise<CloudGrant>;
	/** Remove one grant; live sessions that lose access are cut immediately. */
	revoke(grant: { subject: string; prefix: string }): Promise<boolean>;
	/** Stored documents, rows, bytes and open sockets of a root (API key only). */
	usage(root: string): Promise<CloudRootUsage>;
	/**
	 * Erase a document, its sub-documents and their grants (the API key, or an
	 * owner of `docId`). Their open sessions fail with `NOT_FOUND`; the root
	 * document erases the whole root. Resolves to how many documents had data.
	 */
	deleteDocument(docId: string): Promise<number>;
	/**
	 * Erase the whole root once it has had no open socket for `idleMs`
	 * (at least a minute), as `deleteDocument(root)` would: for rooms that
	 * live as long as someone uses them. The API key, or an owner of the root.
	 * Counted from now when nobody is connected.
	 */
	expire(
		root: string,
		options: { idleMs: number },
	): Promise<{ idleMs: number }>;
	/**
	 * Keep a copy of a document as the server holds it now (the API key, or an
	 * editor of `docId`). The copy is made by the server, which never reads
	 * the document: a client only has to have sent its edits.
	 */
	snapshot(docId: string, options?: { label?: string }): Promise<CloudSnapshot>;
	/** The snapshots of a document, oldest first (the API key, or a reader of `docId`). */
	snapshots(docId: string, filter?: { since?: Date }): Promise<CloudSnapshot[]>;
	/**
	 * Open a snapshot as a read-only pulse, detached from the live document
	 * and migrated to the definition's latest version (the API key, or a
	 * reader of `docId`). Read it, render it, or pass it to `restorePulse`;
	 * destroy it when done.
	 */
	loadSnapshot<Definition extends AnyPulseDefinition>(
		definition: Definition,
		docId: string,
		id: string,
	): Promise<Pulse<ModelFromDefinition<Definition>>>;
	/** Erase one snapshot (the API key, or an owner of `docId`). */
	deleteSnapshot(docId: string, id: string): Promise<boolean>;
	/**
	 * The user behind an actor: the subject of the token under which a client
	 * first declared the actor as its own, kept by the root for good.
	 * `undefined` for an actor no account has claimed. Pass the `actor` of a
	 * version of `getPulseHistory(pulse)` and the pulse's ID.
	 *
	 * A reader of `docId` asks about the actors that wrote `docId`, and gets
	 * `undefined` for any other; the API key asks about any actor of the root.
	 * This is who owns the actor, not a proof of who wrote each of its
	 * transactions: `authors` tells which of them that user sent. Where the
	 * account can change on a device, give each account its own scope
	 * (`createPulseScope({ identity })`), or they share actors.
	 */
	actorSubject(docId: string, actor: number): Promise<string | undefined>;
	/**
	 * Who wrote a document, transaction by transaction (the API key, or a
	 * reader of `docId`): the account of every actor, and whether each
	 * transaction was sent by that account or relayed by another.
	 */
	authors(docId: string): Promise<CloudAuthors>;
};

/** The management API of a deployment, identical on every backend. */
export function createCloudClient(options: CloudClientOptions): CloudClient {
	const base = options.url.replace(/^ws(s?):/, "http$1:").replace(/\/+$/, "");
	const send = async (
		root: string,
		action: Exclude<CloudAction, "connect">,
		init: {
			method: string;
			query?: Record<string, string | undefined>;
			body?: unknown;
		},
	): Promise<Response> => {
		const credential =
			typeof options.credential === "function"
				? await options.credential()
				: options.credential;
		const url = new URL(`${base}${cloudPath(root, action)}`);
		for (const [name, value] of Object.entries(init.query ?? {}))
			if (value !== undefined) url.searchParams.set(name, value);
		const response = await (options.fetch ?? fetch)(url, {
			method: init.method,
			headers: {
				Authorization: `Bearer ${credential}`,
				...(init.body === undefined
					? {}
					: { "Content-Type": "application/json" }),
			},
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
		});
		if (!response.ok) {
			const body = (await response.json().catch(() => undefined)) as
				{ error?: { code?: unknown; message?: unknown } } | undefined;
			const code = body?.error?.code;
			throw new CloudError(
				isCloudErrorCode(code) ? code : "UNAVAILABLE",
				typeof body?.error?.message === "string"
					? body.error.message
					: `HTTP ${response.status}`,
			);
		}
		return response;
	};
	const request = async <T>(...input: Parameters<typeof send>): Promise<T> =>
		(await (await send(...input)).json().catch(() => undefined)) as T;
	return {
		grants: async (root, filter = {}) =>
			(
				await request<{ grants: CloudGrant[] }>(root, "grants", {
					method: "GET",
					query: filter,
				})
			).grants,
		grant: async (grant) =>
			(
				await request<{ grant: CloudGrant }>(rootOf(grant.prefix), "grants", {
					method: "PUT",
					body: grant,
				})
			).grant,
		revoke: async ({ subject, prefix }) =>
			(
				await request<{ removed: boolean }>(rootOf(prefix), "grants", {
					method: "DELETE",
					query: { subject, prefix },
				})
			).removed,
		usage: (root) => request<CloudRootUsage>(root, "usage", { method: "GET" }),
		expire: (root, { idleMs }) =>
			request<{ idleMs: number }>(root, "expire", {
				method: "PUT",
				body: { idleMs },
			}),
		snapshot: async (docId, { label } = {}) =>
			(
				await request<{ snapshot: CloudSnapshot }>(rootOf(docId), "snapshots", {
					method: "POST",
					query: { docId },
					body: { label },
				})
			).snapshot,
		snapshots: async (docId, { since } = {}) =>
			(
				await request<{ snapshots: CloudSnapshot[] }>(
					rootOf(docId),
					"snapshots",
					{
						method: "GET",
						query: { docId, since: since && String(since.getTime()) },
					},
				)
			).snapshots,
		loadSnapshot: async (definition, docId, id) => {
			const response = await send(rootOf(docId), "snapshots", {
				method: "GET",
				query: { docId, id },
			});
			// Frames one after the other, each after its length on four bytes.
			const bytes = new Uint8Array(await response.arrayBuffer());
			const view = new DataView(bytes.buffer);
			const frames: Uint8Array[] = [];
			for (let at = 0; at < bytes.length;) {
				const end = at + 4 + (at + 4 <= bytes.length ? view.getUint32(at) : 0);
				if (end > bytes.length)
					throw new CloudError("UNAVAILABLE", "Truncated snapshot");
				frames.push(bytes.subarray(at + 4, end));
				at = end;
			}
			return openPulseSnapshot(definition, docId, frames);
		},
		deleteSnapshot: async (docId, id) =>
			(
				await request<{ removed: boolean }>(rootOf(docId), "snapshots", {
					method: "DELETE",
					query: { docId, id },
				})
			).removed,
		actorSubject: async (docId, actor) =>
			(
				await request<{ subject: string | null }>(rootOf(docId), "actors", {
					method: "GET",
					query: { docId, actor: String(actor) },
				})
			).subject ?? undefined,
		authors: async (docId) => {
			const { actors, received } = await request<CloudAuthorRecords>(
				rootOf(docId),
				"authors",
				{ method: "GET", query: { docId } },
			);
			const subjects = new Map(actors);
			return {
				actors: subjects,
				of({ actor, clock }) {
					const subject = subjects.get(actor);
					// Ranges of one actor are sorted: the last one that starts at
					// or before the clock is the one that was stored with it.
					const range = received.findLast(
						(each) =>
							each.actor === actor && each.clock <= clock && clock < each.end,
					);
					return {
						...(subject === undefined ? {} : { subject }),
						...(range ? { receivedFrom: range.subject } : {}),
						verified: subject !== undefined && range?.subject === subject,
					};
				},
			};
		},
		deleteDocument: async (docId) =>
			(
				await request<{ deleted: number }>(rootOf(docId), "documents", {
					method: "DELETE",
					query: { docId },
				})
			).deleted,
	};
}
