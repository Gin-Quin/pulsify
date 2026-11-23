import {
	stateDeltaOf,
	historyRequestOf,
	encodeHistoryRequest,
	decodeStateMessage,
	encodeStateMessage,
} from "../protocol/stateDeltas.js";
import {
	decodeRunMessage,
	encodeOwnedRun,
	rowDependencies,
	rowOperations,
} from "../protocol/scalarRuns.js";
import {
	type ArraySchema,
	type Decoder,
	type InferType,
	type ObjectSchema,
	type TupleSchema,
	type UnionSchema,
	array,
	createDecoder,
	object,
	readUint8,
	readUint8Array,
	readVarString,
	readVarUint,
	tuple,
	union,
} from "@gin-quin/codec";
import { wireCodec } from "../protocol/wireCodec.js";
import { PulseError } from "../protocol/errors.js";
import {
	MAX_FRAME_BYTES,
	MAX_MESSAGE_ROWS,
	MAX_PATCH_BYTES,
	MAX_VECTOR_ENTRIES,
} from "../protocol/limits.js";
import {
	validateVector,
	type PulseVersionVector,
} from "./PulseVersionVector.js";
import { validateDocId } from "../protocol/validateDocId.js";
import { OPERATIONS_VERSION } from "../protocol/versions.js";

export const PROTOCOL_VERSION = 1;
export { OPERATIONS_VERSION } from "../protocol/versions.js";
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
type VersionVectorSchema = ArraySchema<TupleSchema<["uint", "uint"]>>;
type PatchRowSchema = ObjectSchema<{
	docId: "string";
	sid: "uint";
	clock: "uint";
	span: "uint";
	dependencies: VersionVectorSchema;
	operations: "uint8Array";
}>;
type RowsSchema = ArraySchema<PatchRowSchema>;
type MessageVariants = {
	1: { docId: "string"; requestId: "uint"; vv: VersionVectorSchema };
	2: {
		docId: "string";
		requestId: "uint";
		found: "boolean";
		complete: "boolean";
		vv: VersionVectorSchema;
		rows: RowsSchema;
	};
	3: {
		docId: "string";
		requestId: "uint";
		vv: VersionVectorSchema;
		rows: RowsSchema;
	};
	4: {
		docId: "string";
		requestId: "uint";
		vv: VersionVectorSchema;
		rows: RowsSchema;
	};
	5: { docId: "string"; requestId: "uint"; vv: VersionVectorSchema };
	6: { docId: "string"; requestId: "uint"; code: "string"; message: "string" };
};
export const PulseVersionVectorSchema: VersionVectorSchema = array(
	tuple("uint", "uint"),
);
export const PulsePatchRowSchema: PatchRowSchema = object({
	docId: "string",
	sid: "uint",
	clock: "uint",
	span: "uint",
	dependencies: PulseVersionVectorSchema,
	operations: "uint8Array",
});
const common = { docId: "string", requestId: "uint" } as const;
export const PulseMessageSchema: UnionSchema<"uint", MessageVariants, "kind"> =
	union({
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
			const operations = rowOperations(row);
			const dependencies = rowDependencies(row);
			if (operations.length > MAX_PATCH_BYTES)
				throw new PulseError("LIMIT_EXCEEDED", "Patch payload exceeds 1 MiB");
			validateVector(dependencies);
			if (
				row.docId !== message.docId ||
				row.sid < 65536 ||
				!Number.isSafeInteger(row.clock + row.span) ||
				row.clock < 1 ||
				row.span < 1 ||
				!operations.length
			)
				throw new PulseError("INVALID_MESSAGE", "Invalid patch row");
			let own = 0;
			for (let i = 0; i < dependencies.length; i++) {
				const entry = dependencies[i]!;
				if (entry[0] === row.sid) {
					own = entry[1];
					break;
				}
				if (entry[0] > row.sid) break;
			}
			if (own > row.clock)
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
function readBoundedVector(d: Decoder): PulseVersionVector {
	const count = readVarUint(d);
	if (count > MAX_VECTOR_ENTRIES)
		throw new PulseError("INVALID_MESSAGE", "Invalid version vector");
	const vv: PulseVersionVector = new Array(count);
	for (let i = 0; i < count; i++) vv[i] = [readVarUint(d), readVarUint(d)];
	return vv;
}
function readBoundedRows(
	d: Decoder,
): Array<InferType<typeof PulsePatchRowSchema>> {
	const count = readVarUint(d);
	if (count > MAX_MESSAGE_ROWS)
		throw new PulseError("LIMIT_EXCEEDED", "Too many patch rows");
	const rows: Array<InferType<typeof PulsePatchRowSchema>> = new Array(count);
	for (let i = 0; i < count; i++) {
		const docId = readVarString(d);
		const sid = readVarUint(d);
		const clock = readVarUint(d);
		const span = readVarUint(d);
		const dependencies = readBoundedVector(d);
		const opLength = readVarUint(d);
		if (opLength > MAX_PATCH_BYTES)
			throw new PulseError("LIMIT_EXCEEDED", "Patch payload exceeds 1 MiB");
		const operations = readUint8Array(d, opLength);
		rows[i] = { docId, sid, clock, span, dependencies, operations };
	}
	return rows;
}
function decodeEnvelope1(bytes: Uint8Array): PulseMessage {
	if (bytes.length > MAX_FRAME_BYTES)
		throw new PulseError("LIMIT_EXCEEDED", "Message exceeds 8 MiB");
	let message: PulseMessage;
	try {
		const d = createDecoder(bytes);
		const protocolVersion = readVarUint(d);
		const operationsVersion = readVarUint(d);
		if (
			protocolVersion !== PROTOCOL_VERSION ||
			operationsVersion !== OPERATIONS_VERSION
		)
			throw new PulseError(
				"UNSUPPORTED_VERSION",
				"Unsupported protocol or operations version",
			);
		const kind = readVarUint(d);
		switch (kind) {
			case 1:
				message = {
					kind: 1,
					docId: readVarString(d),
					requestId: readVarUint(d),
					vv: readBoundedVector(d),
				};
				break;
			case 2:
				message = {
					kind: 2,
					docId: readVarString(d),
					requestId: readVarUint(d),
					found: readUint8(d) === 1,
					complete: readUint8(d) === 1,
					vv: readBoundedVector(d),
					rows: readBoundedRows(d),
				};
				break;
			case 3:
				message = {
					kind: 3,
					docId: readVarString(d),
					requestId: readVarUint(d),
					vv: readBoundedVector(d),
					rows: readBoundedRows(d),
				};
				break;
			case 4:
				message = {
					kind: 4,
					docId: readVarString(d),
					requestId: readVarUint(d),
					vv: readBoundedVector(d),
					rows: readBoundedRows(d),
				};
				break;
			case 5:
				message = {
					kind: 5,
					docId: readVarString(d),
					requestId: readVarUint(d),
					vv: readBoundedVector(d),
				};
				break;
			case 6:
				message = {
					kind: 6,
					docId: readVarString(d),
					requestId: readVarUint(d),
					code: readVarString(d),
					message: readVarString(d),
				};
				break;
			default:
				throw new PulseError("INVALID_MESSAGE", "Cannot decode message");
		}
		if (d.pos !== bytes.length)
			throw new PulseError("INVALID_MESSAGE", "Trailing bytes");
	} catch (error) {
		if (error instanceof PulseError) throw error;
		throw new PulseError("INVALID_MESSAGE", "Cannot decode message", {
			cause: error,
		});
	}
	validateMessage(message);
	return message;
}
export function decodeMessage(bytes: Uint8Array): PulseMessage {
	if (bytes[0] === 3 && bytes[1] === OPERATIONS_VERSION)
		return decodeStateMessage(bytes);
	if (bytes[0] === 2 && bytes[1] === OPERATIONS_VERSION)
		return decodeRunMessage(bytes);
	// Check versions before interpreting a body which may belong to another format.
	if (bytes[0] !== PROTOCOL_VERSION || bytes[1] !== OPERATIONS_VERSION)
		throw new PulseError(
			"UNSUPPORTED_VERSION",
			"Unsupported protocol or operations version",
		);
	return decodeEnvelope1(bytes);
}
