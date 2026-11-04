import {
	stateDeltaOf,
	historyRequestOf,
	encodeHistoryRequest,
	decodeStateMessage,
	encodeStateMessage,
} from "../protocol/stateDeltas.js";
import { decodeRunMessage, encodeOwnedRun } from "../protocol/scalarRuns.js";
import { type InferType, array, object, tuple, union } from "@gin-quin/codec";
import { wireCodec } from "../protocol/wireCodec.js";
import { PulseError } from "../protocol/errors.js";
import { MAX_MESSAGE_ROWS, MAX_PATCH_BYTES } from "../protocol/limits.js";
import { validateVector } from "./PulseVersionVector.js";
import { validateDocId } from "../protocol/validateDocId.js";

export const PROTOCOL_VERSION = 1;
export const OPERATIONS_VERSION = 2;
export { MAX_MESSAGE_ROWS } from "../protocol/limits.js";
export const PulseMessageKind = {
	connect: 1,
	sync: 2,
	syncBack: 3,
	update: 4,
	ack: 5,
	error: 6,
} as const;
export type PulseMessageKinds = typeof PulseMessageKind;
export type PulseMessageKind = PulseMessageKinds[keyof PulseMessageKinds];
export const PulseVersionVectorSchema = array(tuple("uint", "uint"));
export const PulsePatchRowSchema = object({
	docId: "string",
	sid: "uint",
	clock: "uint",
	span: "uint",
	dependencies: PulseVersionVectorSchema,
	operations: "uint8Array",
});
const common = { docId: "string", requestId: "uint" } as const;
export const PulseMessageSchema = union({
	tagName: "kind",
	tagType: "uint",
	variants: {
		1: { ...common, vv: PulseVersionVectorSchema },
		2: {
			...common,
			found: "boolean",
			complete: "boolean",
			vv: PulseVersionVectorSchema,
			rows: array(PulsePatchRowSchema),
		},
		3: {
			...common,
			vv: PulseVersionVectorSchema,
			rows: array(PulsePatchRowSchema),
		},
		4: {
			...common,
			vv: PulseVersionVectorSchema,
			rows: array(PulsePatchRowSchema),
		},
		5: { ...common, vv: PulseVersionVectorSchema },
		6: { ...common, code: "string", message: "string" },
	},
});
export type PulseMessage = InferType<typeof PulseMessageSchema>;
export type PulseConnectMessage = Extract<PulseMessage, { kind: 1 }>;
export type PulseSyncMessage = Extract<PulseMessage, { kind: 2 }>;
export type PulseSyncBackMessage = Extract<PulseMessage, { kind: 3 }>;
export type PulseUpdateMessage = Extract<PulseMessage, { kind: 4 }>;
const codec = wireCodec(
	object({
		protocolVersion: "uint",
		operationsVersion: "uint",
		message: PulseMessageSchema,
	}),
);

export function validateMessage(message: PulseMessage): void {
	validateDocId(message.docId);
	if ("vv" in message) validateVector(message.vv);
	if ("rows" in message) {
		if (message.rows.length > MAX_MESSAGE_ROWS)
			throw new PulseError("LIMIT_EXCEEDED", "Too many patch rows");
		for (const row of message.rows) {
			if (row.operations.length > MAX_PATCH_BYTES)
				throw new PulseError("LIMIT_EXCEEDED", "Patch payload exceeds 1 MiB");
			validateVector(row.dependencies);
			if (
				row.docId !== message.docId ||
				row.sid < 65536 ||
				!Number.isSafeInteger(row.clock + row.span) ||
				row.clock < 1 ||
				row.span < 1 ||
				!row.operations.length
			)
				throw new PulseError("INVALID_MESSAGE", "Invalid patch row");
			if ((new Map(row.dependencies).get(row.sid) ?? 0) > row.clock)
				throw new PulseError(
					"INVALID_MESSAGE",
					"Patch precedes its dependencies",
				);
		}
	}
}
export function encodeMessage(
	message: PulseMessage,
	options: { peerVersion?: 1 | 2 | 3 } = {},
): Uint8Array<ArrayBuffer> {
	if (message.kind === 1 && options.peerVersion === 3)
		return encodeHistoryRequest(message, historyRequestOf(message) ?? false);
	if ("rows" in message) {
		const delta = stateDeltaOf(message.rows);
		if (delta) {
			if (options.peerVersion !== 3)
				throw new PulseError(
					"HISTORY_UNAVAILABLE",
					"State is not exact operation history",
				);
			return encodeStateMessage(message, delta);
		}
	}
	if (
		(options.peerVersion === 2 || options.peerVersion === 3) &&
		"rows" in message &&
		(message.kind === 2 || message.kind === 3 || message.kind === 4)
	) {
		validateDocId(message.docId);
		validateVector(message.vv);
		const grouped = encodeOwnedRun(message);
		if (grouped) return grouped;
	}
	validateMessage(message);
	return codec.encode({
		protocolVersion: PROTOCOL_VERSION,
		operationsVersion: OPERATIONS_VERSION,
		message,
	});
}
export function decodeMessage(bytes: Uint8Array): PulseMessage {
	if (bytes[0] === 3 && bytes[1] === 2) return decodeStateMessage(bytes);
	if (bytes[0] === 2 && bytes[1] === OPERATIONS_VERSION)
		return decodeRunMessage(bytes);
	// Check versions before interpreting a body which may belong to another format.
	if (bytes[0] !== PROTOCOL_VERSION || bytes[1] !== OPERATIONS_VERSION)
		throw new PulseError(
			"UNSUPPORTED_VERSION",
			"Unsupported protocol or operations version",
		);
	const { message } = codec.decode(bytes);
	validateMessage(message);
	return message;
}
