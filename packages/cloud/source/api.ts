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
		deleteDocument: async (docId) =>
			(
				await request<{ deleted: number }>(rootOf(docId), "documents", {
					method: "DELETE",
					query: { docId },
				})
			).deleted,
	};
}
