import { validateVector, type PulseVersionVector } from "pulsify-core/protocol";
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
	/** The host, for example `"cloudflare"`. */
	backend: string;
	/** The instance serving the root. A new value means a new instance. */
	id: string;
	/** Where the socket was accepted. */
	location?: string;
};
/**
 * Server → client, first frame of every socket: who answers it, and whether
 * it relays presence frames (a client never sends them to a server that
 * does not say so).
 */
export type CloudWelcomeMessage = {
	type: "welcome";
	server: CloudServerInfo;
	presence?: boolean;
	subtrees?: boolean;
	/** The server pushes live updates for watched descendant subtrees (`watch`/`unwatch`). */
	watch?: boolean;
	/** The server binds actors to accounts: it accepts `actors` messages. */
	authors?: boolean;
	/** The account the server authenticated this socket as, from its token. */
	subject?: string;
};
/** The most actors one `actors` message names: as many as a document has. */
export const MAX_DECLARED_ACTORS = 1024;
/**
 * Client → server, when it connects to `docId` and before it uploads rows of
 * these actors: they are actors this client created, not ones whose rows it
 * relays. The server binds each one to the socket's account, for good,
 * unless another account has it; it ignores the message, without an answer,
 * from a session that cannot write `docId`.
 */
export type CloudActorsMessage = {
	type: "actors";
	docId: string;
	actors: number[];
};
/**
 * Server → client: the actors of an `actors` message that another account
 * has. Their rows are still stored, unverified: the client stops writing
 * under them.
 */
export type CloudActorsRefusedMessage = {
	type: "actors";
	docId: string;
	refused: number[];
};
/** Client → server: stop receiving a document's updates without closing the socket. */
export type CloudUnsubscribeMessage = { type: "unsubscribe"; docId: string };
/** Client → server: receive live broadcasts for newly created descendants (`docId/…`). */
export type CloudWatchMessage = { type: "watch"; docId: string };
/** Client → server: stop receiving live broadcasts for descendants of `docId`. */
export type CloudUnwatchMessage = { type: "unwatch"; docId: string };
export type CloudFetchMessage = {
	type: "fetch";
	docId: string;
	requestId: number;
	descendants: boolean;
	vectors: [string, PulseVersionVector][];
};
export type CloudFetchedMessage = {
	type: "fetched";
	requestId: number;
	complete: boolean;
};
/** Flow control within one fetch, never a request for another page. */
export type CloudFetchBatchMessage = {
	type: "fetch-batch";
	requestId: number;
	batch: number;
};
export type CloudFetchAckMessage = {
	type: "fetch-ack";
	requestId: number;
	batch: number;
};
export type CloudCancelFetchMessage = {
	type: "cancel-fetch";
	requestId: number;
};
export type CloudServerMessage =
	| CloudRoleMessage
	| CloudWelcomeMessage
	| CloudFetchedMessage
	| CloudFetchBatchMessage
	| CloudActorsRefusedMessage;

export function welcomeMessage(
	server: CloudServerInfo,
	capabilities: {
		presence?: boolean;
		subtrees?: boolean;
		watch?: boolean;
		authors?: boolean;
		subject?: string;
	} = {},
): string {
	const message: CloudWelcomeMessage = {
		type: "welcome",
		server,
		...(capabilities.presence ? { presence: true } : {}),
		...(capabilities.subtrees ? { subtrees: true } : {}),
		...(capabilities.watch ? { watch: true } : {}),
		...(capabilities.authors ? { authors: true } : {}),
		...(capabilities.subject === undefined
			? {}
			: { subject: capabilities.subject }),
	};
	return JSON.stringify(message);
}
export type CloudClientMessage =
	| CloudUnsubscribeMessage
	| CloudWatchMessage
	| CloudUnwatchMessage
	| CloudFetchMessage
	| CloudFetchAckMessage
	| CloudCancelFetchMessage
	| CloudActorsMessage;

/** Actor IDs as documents hold them: safe integers from 65536. */
function actorList(value: unknown): value is number[] {
	return (
		Array.isArray(value) &&
		value.length <= MAX_DECLARED_ACTORS &&
		value.every((actor) => Number.isSafeInteger(actor) && actor >= 65536)
	);
}

function fetchRequestId(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 2 ** 52;
}
function batchNumber(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 1;
}

export function parseClientMessage(text: string): CloudClientMessage {
	if (text.length > 64 * 1024)
		throw new CloudError("LIMIT_EXCEEDED", "Control message is too large");
	const message = parseObject(text);
	if (message["type"] === "actors") {
		if (typeof message["docId"] !== "string" || !actorList(message["actors"]))
			throw new CloudError("BAD_REQUEST", "Invalid actor declaration");
		return {
			type: "actors",
			docId: message["docId"],
			actors: message["actors"],
		};
	}
	if (message["type"] === "cancel-fetch") {
		if (!fetchRequestId(message["requestId"]))
			throw new CloudError("BAD_REQUEST", "Invalid fetch cancellation");
		return { type: "cancel-fetch", requestId: message["requestId"] };
	}
	if (message["type"] === "fetch-ack") {
		if (!fetchRequestId(message["requestId"]) || !batchNumber(message["batch"]))
			throw new CloudError("BAD_REQUEST", "Invalid fetch acknowledgement");
		return {
			type: "fetch-ack",
			requestId: message["requestId"],
			batch: message["batch"],
		};
	}
	if (message["type"] === "fetch") {
		const { docId, requestId, descendants, vectors } = message;
		if (
			typeof docId !== "string" ||
			!fetchRequestId(requestId) ||
			typeof descendants !== "boolean" ||
			!Array.isArray(vectors) ||
			vectors.length > 4096
		)
			throw new CloudError("BAD_REQUEST", "Invalid subtree request");
		for (const entry of vectors) {
			if (
				!Array.isArray(entry) ||
				entry.length !== 2 ||
				typeof entry[0] !== "string"
			)
				throw new CloudError("BAD_REQUEST", "Invalid subtree vector");
			validateVector(entry[1]);
		}
		return {
			type: "fetch",
			docId,
			requestId: requestId as number,
			descendants,
			vectors,
		};
	}
	if (message["type"] === "watch" || message["type"] === "unwatch") {
		if (typeof message["docId"] !== "string")
			throw new CloudError("BAD_REQUEST", "Invalid watch message");
		return { type: message["type"], docId: message["docId"] };
	}
	if (message["type"] !== "unsubscribe" || typeof message["docId"] !== "string")
		throw new CloudError("BAD_REQUEST", "Unknown control message");
	return { type: "unsubscribe", docId: message["docId"] };
}
export function parseServerMessage(text: string): CloudServerMessage {
	const message = parseObject(text);
	if (message["type"] === "actors") {
		if (typeof message["docId"] !== "string" || !actorList(message["refused"]))
			throw new CloudError("BAD_REQUEST", "Invalid actor refusal");
		return {
			type: "actors",
			docId: message["docId"],
			refused: message["refused"],
		};
	}
	if (message["type"] === "fetch-batch") {
		if (!fetchRequestId(message["requestId"]) || !batchNumber(message["batch"]))
			throw new CloudError("BAD_REQUEST", "Invalid fetch batch");
		return {
			type: "fetch-batch",
			requestId: message["requestId"],
			batch: message["batch"],
		};
	}
	if (message["type"] === "fetched") {
		if (
			!fetchRequestId(message["requestId"]) ||
			typeof message["complete"] !== "boolean"
		)
			throw new CloudError("BAD_REQUEST", "Invalid subtree completion");
		return {
			type: "fetched",
			requestId: message["requestId"] as number,
			complete: message["complete"],
		};
	}
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
			...(message["presence"] === true ? { presence: true } : {}),
			...(message["subtrees"] === true ? { subtrees: true } : {}),
			...(message["watch"] === true ? { watch: true } : {}),
			...(message["authors"] === true ? { authors: true } : {}),
			...(typeof message["subject"] === "string"
				? { subject: message["subject"] }
				: {}),
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

export type CloudAction =
	| "connect"
	| "grants"
	| "usage"
	| "documents"
	| "expire"
	| "snapshots"
	| "actors"
	| "authors";
export const CLOUD_HEALTH_PATH = "/v1/health";
/** `/v1/roots/{root}/{action}`, with the root percent-encoded as one segment. */
export function cloudPath(root: string, action: CloudAction): string {
	return `/v1/roots/${encodeURIComponent(root)}/${action}`;
}
export function parseCloudPath(
	pathname: string,
): { root: string; action: CloudAction } | undefined {
	const match =
		/^\/v1\/roots\/([^/]+)\/(connect|grants|usage|documents|expire|snapshots|actors|authors)\/?$/.exec(
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
