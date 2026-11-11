import type { CloudCredential } from "./client.js";
import { CloudError, isCloudErrorCode } from "./errors.js";
import { rootOf } from "./ids.js";
import type { CloudGrant } from "./roles.js";
import { cloudPath } from "./wire.js";

/** Storage and connections of one root, from `usage` with the API key. */
export type CloudRootUsage = {
	root: string;
	documents: number;
	rows: number;
	bytes: number;
	connections: number;
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
};

/** The management API of a deployment, identical on every backend. */
export function createCloudClient(options: CloudClientOptions): CloudClient {
	const base = options.url.replace(/^ws(s?):/, "http$1:").replace(/\/+$/, "");
	const request = async <T>(
		root: string,
		action: "grants" | "usage",
		init: {
			method: string;
			query?: Record<string, string | undefined>;
			body?: unknown;
		},
	): Promise<T> => {
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
		const body = (await response.json().catch(() => undefined)) as
			{ error?: { code?: unknown; message?: unknown } } | undefined;
		if (!response.ok) {
			const code = body?.error?.code;
			throw new CloudError(
				isCloudErrorCode(code) ? code : "UNAVAILABLE",
				typeof body?.error?.message === "string"
					? body.error.message
					: `HTTP ${response.status}`,
			);
		}
		return body as T;
	};
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
	};
}
