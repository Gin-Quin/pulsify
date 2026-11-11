import { CloudError } from "./errors.js";
import { assertRoot } from "./ids.js";
import { isCloudRole, type CloudRole } from "./roles.js";

/**
 * Cloud session protocol 1. One WebSocket per user and root carries the
 * unchanged Pulsify binary frames of any number of documents of that root
 * (each frame names its document), plus JSON text frames for session control.
 * The selected subprotocol also fixes the Pulsify envelope: 1 or grouped 2.
 */
export const CLOUD_SUBPROTOCOLS = {
	1: "pulsify-cloud.1.e1",
	2: "pulsify-cloud.1.e2",
} as const;
export type CloudEnvelope = keyof typeof CLOUD_SUBPROTOCOLS;
/** Browsers cannot set headers on a WebSocket: the token rides as a subprotocol. */
export const CLOUD_TOKEN_SUBPROTOCOL = "pulsify-cloud.token.";

/**
 * Liveness check of a socket, one per socket rather than per document. Exact
 * strings, so Cloudflare answers without waking the Durable Object
 * (`setWebSocketAutoResponse`).
 */
export const CLOUD_PING = '{"type":"ping"}';
export const CLOUD_PONG = '{"type":"pong"}';

/** Server → client: the role of this session on a document, sent on subscribe and on every change. `null` means revoked. */
export type CloudRoleMessage = {
	type: "role";
	docId: string;
	role: CloudRole | null;
};
/** Who answers a socket, for debugging: free-form, never used for routing. */
export type CloudServerInfo = {
	/** `"cloudflare"`, `"unikraft-cloud"`, or another host. */
	backend: string;
	/** The Durable Object ID, or the machine instance. A new value means a new instance. */
	id: string;
	/** The Cloudflare edge that accepted the socket, or the Unikraft metro. */
	location?: string;
};
/** Server → client, first frame of every socket: who answers it. */
export type CloudWelcomeMessage = { type: "welcome"; server: CloudServerInfo };
/** Client → server: stop receiving a document's updates without closing the socket. */
export type CloudUnsubscribeMessage = { type: "unsubscribe"; docId: string };
export type CloudServerMessage = CloudRoleMessage | CloudWelcomeMessage;

export function welcomeMessage(server: CloudServerInfo): string {
	const message: CloudWelcomeMessage = { type: "welcome", server };
	return JSON.stringify(message);
}
export type CloudClientMessage = CloudUnsubscribeMessage;

export function parseClientMessage(text: string): CloudClientMessage {
	const message = parseObject(text);
	if (message["type"] !== "unsubscribe" || typeof message["docId"] !== "string")
		throw new CloudError("BAD_REQUEST", "Unknown control message");
	return { type: "unsubscribe", docId: message["docId"] };
}
export function parseServerMessage(text: string): CloudServerMessage {
	const message = parseObject(text);
	if (message["type"] === "welcome") {
		const server = message["server"] as Record<string, unknown> | null;
		if (
			typeof server !== "object" ||
			server === null ||
			typeof server["backend"] !== "string" ||
			typeof server["id"] !== "string" ||
			(server["location"] !== undefined &&
				typeof server["location"] !== "string")
		)
			throw new CloudError("BAD_REQUEST", "Invalid welcome message");
		return {
			type: "welcome",
			server: {
				backend: server["backend"],
				id: server["id"],
				...(typeof server["location"] === "string"
					? { location: server["location"] }
					: {}),
			},
		};
	}
	const { docId, role } = message;
	if (
		message["type"] !== "role" ||
		typeof docId !== "string" ||
		(role !== null && !isCloudRole(role))
	)
		throw new CloudError("BAD_REQUEST", "Unknown control message");
	return { type: "role", docId, role };
}
function parseObject(text: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new CloudError("BAD_REQUEST", "Control messages are JSON");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new CloudError("BAD_REQUEST", "Control messages are JSON objects");
	return value as Record<string, unknown>;
}

/** Pick the strongest envelope the client offers and read its token, if any. */
export function readSubprotocols(header: string | null): {
	envelope: CloudEnvelope | undefined;
	token: string | undefined;
} {
	const offered = (header ?? "").split(",").map((value) => value.trim());
	const token = offered
		.find((value) => value.startsWith(CLOUD_TOKEN_SUBPROTOCOL))
		?.slice(CLOUD_TOKEN_SUBPROTOCOL.length);
	const envelope = offered.includes(CLOUD_SUBPROTOCOLS[2])
		? 2
		: offered.includes(CLOUD_SUBPROTOCOLS[1])
			? 1
			: undefined;
	return { envelope, token: token || undefined };
}

export type FrameHeader = {
	envelope: number;
	kind: number;
	docId: string;
	requestId: number;
};
const utf8 = new TextDecoder("utf-8", { fatal: true });
/**
 * Read only the common header of a Pulsify frame (every envelope starts with
 * `version, operations, kind, docId, requestId`), to route it before decoding.
 */
export function peekFrameHeader(bytes: Uint8Array): FrameHeader {
	let offset = 0;
	const uint = () => {
		let value = 0;
		for (let shift = 1, i = 0; i < 8; i++, shift *= 128) {
			const byte = bytes[offset++];
			if (byte === undefined) break;
			value += (byte & 127) * shift;
			if (byte < 128) return value;
		}
		throw new CloudError("BAD_REQUEST", "Truncated frame header");
	};
	const envelope = uint();
	uint();
	const kind = uint();
	const length = uint();
	if (offset + length > bytes.length)
		throw new CloudError("BAD_REQUEST", "Truncated frame header");
	let docId: string;
	try {
		docId = utf8.decode(bytes.subarray(offset, offset + length));
	} catch {
		throw new CloudError("BAD_REQUEST", "Invalid document ID");
	}
	offset += length;
	return { envelope, kind, docId, requestId: uint() };
}

export type CloudAction = "connect" | "grants" | "usage";
export const CLOUD_HEALTH_PATH = "/v1/health";
/** `/v1/roots/{root}/{action}`, with the root percent-encoded as one segment. */
export function cloudPath(root: string, action: CloudAction): string {
	return `/v1/roots/${encodeURIComponent(root)}/${action}`;
}
export function parseCloudPath(
	pathname: string,
): { root: string; action: CloudAction } | undefined {
	const match = /^\/v1\/roots\/([^/]+)\/(connect|grants|usage)\/?$/.exec(
		pathname,
	);
	if (!match) return undefined;
	let root: string;
	try {
		root = decodeURIComponent(match[1]!);
	} catch {
		throw new CloudError("BAD_REQUEST", "Invalid root document ID");
	}
	assertRoot(root);
	return { root, action: match[2] as CloudAction };
}
