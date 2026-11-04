import { type InferType, array, object, tuple, union } from "@gin-quin/codec";
import { wireCodec } from "../protocol/wireCodec.js";
import { PulseError } from "../protocol/errors.js";
import { MAX_MESSAGE_ROWS, MAX_PATCH_BYTES } from "../protocol/limits.js";
import { validateVector } from "./PulseVersionVector.js";

export const PROTOCOL_VERSION = 1;
export const OPERATIONS_VERSION = 1;
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
	if (!message.docId.length || message.docId.length > 1024)
		throw new PulseError("INVALID_MESSAGE", "Invalid document ID");
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
export function encodeMessage(message: PulseMessage): Uint8Array<ArrayBuffer> {
	validateMessage(message);
	return codec.encode({
		protocolVersion: PROTOCOL_VERSION,
		operationsVersion: OPERATIONS_VERSION,
		message,
	});
}
export function decodeMessage(bytes: Uint8Array): PulseMessage {
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
