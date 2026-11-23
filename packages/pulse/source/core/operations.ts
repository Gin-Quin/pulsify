import {
	array,
	createCodec,
	object,
	tuple,
	union,
	createDecoder,
	createEncoder,
	toUint8Array,
	readVarString,
	readVarUint,
	readVarUint8Array,
	writeVarString,
	writeVarUint,
	writeVarUint8Array,
	writeUint8Array,
	type Decoder,
	type Encoder,
} from "@gin-quin/codec";
import { OPERATIONS_VERSION } from "../protocol/versions.js";
import type { PulsePatchRow } from "../connection/PulsePatch.js";
import { PulseError } from "../protocol/errors.js";
import { MAX_PATCH_BYTES } from "../protocol/limits.js";
import {
	prepareValue,
	validatePrepared,
	type PreparedValue,
} from "./values.js";

export type CoreField = string | number;
export type CoreScalar = null | undefined | boolean | number | string;
/**
 * `last` marks a write to a register that keeps no history: its row is
 * deleted once a newer write to the same register is known. It travels as
 * kind 7 (assignment) or 8 (deletion), and its value creates no node.
 */
export type CoreOperation =
	| { kind: 0; value: PreparedValue }
	| {
			kind: 1;
			target: string;
			field: CoreField;
			value: PreparedValue;
			last?: true;
	  }
	| { kind: 2; target: string; field: CoreField; last?: true }
	| {
			kind: 3;
			target: string;
			after: string;
			deletes: string[];
			values: PreparedValue[];
	  }
	| { kind: 4; target: string; entry: string; value: PreparedValue }
	| { kind: 6; target: string; entries: string[]; after: string }
	| {
			kind: 5;
			target: string;
			entries: string[];
			attributes: Record<string, unknown>;
			/**
			 * A range: `entries` holds its first entry, and the operation covers
			 * the `count` entries one transaction created from it on, whose IDs
			 * follow each other. It travels as kind 11.
			 */
			count?: number;
	  }
	/**
	 * The document becomes what it was at `version`, as a new generation.
	 * Every replica builds that root from its own journal: nothing else travels.
	 */
	| { kind: 10; version: [sid: number, clock: number][]; generation: number }
	/**
	 * Insert Unicode code points into a text node with optional shared attributes.
	 */
	| {
			kind: 12;
			target: string;
			after: string;
			text: string;
			attributes?: Record<string, unknown>;
	  }
	/**
	 * Delete a contiguous range of entries created by one transaction.
	 */
	| {
			kind: 13;
			target: string;
			first: string;
			count: number;
	  };

/** Yield the `count` sequential entry IDs starting at `first` (`sid:clock:serial`). */
export function* expandEntryRange(
	first: string,
	count: number,
): Generator<string> {
	const at = first.lastIndexOf(":"),
		serial = Number(first.slice(at + 1));
	if (
		at < 0 ||
		!Number.isSafeInteger(serial) ||
		serial < 0 ||
		!Number.isSafeInteger(count) ||
		count < 1 ||
		!Number.isSafeInteger(serial + count)
	)
		throw new PulseError("INVALID_MESSAGE", "Invalid entry range");
	const prefix = first.slice(0, at + 1);
	for (let i = 0; i < count; i++) yield prefix + (serial + i);
}

/** The IDs an attribute operation covers: its list, or its range. */
export function* attributeEntries(
	op: Extract<CoreOperation, { kind: 5 }>,
): Generator<string> {
	if (op.count === undefined) return yield* op.entries;
	if (op.entries.length !== 1)
		throw new PulseError("INVALID_MESSAGE", "Invalid entry range");
	yield* expandEntryRange(op.entries[0]!, op.count);
}
export class CorePatch {
	constructor(
		public readonly sid: number,
		public readonly clock: number,
		public readonly lamport: number,
		public readonly schema: string,
		private body: CoreOperation[] | undefined,
		/** The writer's wall clock in milliseconds, for registers that record it. */
		public readonly time?: number,
	) {}
	get ops(): CoreOperation[] {
		return (this.body ??= this.createOperations());
	}
	protected createOperations(): CoreOperation[] {
		return [];
	}
	getId(): { sid: number; time: number } {
		return { sid: this.sid, time: this.clock };
	}
	span(): number {
		return 1;
	}
}
/** A local scalar is already detached; operation wrappers are needed only on export. */
export class ScalarPatch extends CorePatch {
	constructor(
		sid: number,
		clock: number,
		lamport: number,
		schema: string,
		public readonly target: string,
		public readonly field: CoreField,
		public readonly value: CoreScalar,
		public readonly last?: true,
	) {
		super(sid, clock, lamport, schema, undefined);
	}
	protected override createOperations(): CoreOperation[] {
		return [
			{
				kind: 1,
				target: this.target,
				field: this.field,
				value: { value: this.value, constants: [], texts: [] },
				...(this.last ? { last: true as const } : {}),
			},
		];
	}
}
const valueSchema = object({
	layout: "uint",
	data: "uint8Array",
	constants: array(array("string")),
	texts: array(array("string")),
});
const fieldSchema = union(["string", "uint"]);
const operationSchema = union({
	tagName: "kind",
	tagType: "uint",
	variants: {
		0: { value: valueSchema },
		1: { target: "string", field: fieldSchema, value: valueSchema },
		2: { target: "string", field: fieldSchema },
		3: {
			target: "string",
			after: "string",
			deletes: array("string"),
			values: array(valueSchema),
		},
		4: { target: "string", entry: "string", value: valueSchema },
		5: { target: "string", entries: array("string"), attributes: "unknown" },
		6: { target: "string", entries: array("string"), after: "string" },
		// Kinds 7 and 8 are kinds 1 and 2 for a register without history. A store
		// reads their target and field without a schema: see `lastValueOf`.
		7: { target: "string", field: fieldSchema, value: valueSchema },
		8: { target: "string", field: fieldSchema },
		9: { time: "uint" },
		10: { version: array(tuple("uint", "uint")), generation: "uint" },
		// Kind 5 for the entries one transaction created in a row.
		11: {
			target: "string",
			first: "string",
			count: "uint",
			attributes: "unknown",
		},
		// Text insertion carrying shared attributes for the inserted characters.
		12: {
			target: "string",
			after: "string",
			text: "string",
			attributes: "unknown",
		},
		// Sequence deletion for the entries one transaction created in a row.
		13: {
			target: "string",
			first: "string",
			count: "uint",
		},
	},
});
/**
 * A row without operations: its sequence numbers held writes that were
 * replaced. It stands where no earlier row can cover them.
 */
export const GAP_OPERATIONS: Uint8Array = Uint8Array.of(
	OPERATIONS_VERSION,
	1,
	0,
	0,
);
export function isGap(operations: Uint8Array): boolean {
	return (
		operations.length === 4 &&
		operations[0] === OPERATIONS_VERSION &&
		operations[1] === 1 &&
		operations[2] === 0 &&
		operations[3] === 0
	);
}
/** What a journal reads from one last-value write, without a schema. */
export type LastValue = { lamport: number; target: string; field: CoreField };
/** `undefined` unless the patch is one last-value write. */
export function lastValueOfPatch(patch: CorePatch): LastValue | undefined {
	if (patch instanceof ScalarPatch)
		return patch.last
			? { lamport: patch.lamport, target: patch.target, field: patch.field }
			: undefined;
	const op = patch.ops.length === 1 ? patch.ops[0]! : undefined;
	return (op?.kind === 1 || op?.kind === 2) && op.last
		? { lamport: patch.lamport, target: op.target, field: op.field }
		: undefined;
}
/** `undefined` unless the row is one last-value write. */
export function lastValueOf(operations: Uint8Array): LastValue | undefined {
	try {
		const decoder = createDecoder(operations);
		if (readVarUint(decoder) !== OPERATIONS_VERSION) return;
		const lamport = readVarUint(decoder);
		// Read the length first: `pos += read()` would add it to the stale position.
		const schema = readVarUint(decoder);
		decoder.pos += schema;
		if (readVarUint(decoder) !== 1) return;
		const kind = readVarUint(decoder);
		if (kind !== 7 && kind !== 8) return;
		const target = readVarString(decoder);
		const field: CoreField =
			readVarUint(decoder) === 0
				? readVarString(decoder)
				: readVarUint(decoder);
		return { lamport, target, field };
	} catch {
		return;
	}
}
/**
 * The same for a store, which compares registers as bytes: the encoded target
 * and field of the write.
 */
export function lastRegisterOf(
	operations: Uint8Array,
): { lamport: number; register: Uint8Array } | undefined {
	try {
		const decoder = createDecoder(operations);
		if (readVarUint(decoder) !== OPERATIONS_VERSION) return;
		const lamport = readVarUint(decoder);
		const schema = readVarUint(decoder);
		decoder.pos += schema;
		if (readVarUint(decoder) !== 1) return;
		const kind = readVarUint(decoder);
		if (kind !== 7 && kind !== 8) return;
		const start = decoder.pos;
		const target = readVarUint(decoder);
		decoder.pos += target;
		if (readVarUint(decoder) === 0) {
			const field = readVarUint(decoder);
			decoder.pos += field;
		} else readVarUint(decoder);
		if (decoder.pos > operations.length) return;
		return { lamport, register: operations.slice(start, decoder.pos) };
	} catch {
		return;
	}
}
const codec = createCodec(
	object({
		version: "uint",
		lamport: "uint",
		schema: "string",
		ops: array(operationSchema),
	}),
);
const patchEncoder = createEncoder();
// Each slot retains at most 1 KiB, owned independently of network buffers.
// The schema and target commonly repeat throughout a delivered actor history.
const maxCachedStringBytes = 1024;
type CachedString = { value: string; bytes: Uint8Array };
const writtenStrings: Array<CachedString | undefined> = [];
const readStrings: Array<CachedString | undefined> = [];
function writePatchString(encoder: Encoder, value: string, slot: number): void {
	const cached = writtenStrings[slot];
	if (cached?.value === value) {
		writeUint8Array(encoder, cached.bytes);
		return;
	}
	const start = encoder.pos;
	writeVarString(encoder, value);
	if (encoder.pos - start <= maxCachedStringBytes)
		writtenStrings[slot] = {
			value,
			bytes: encoder.buffer.slice(start, encoder.pos),
		};
}
function readPatchString(decoder: Decoder, slot: number): string {
	const start = decoder.pos;
	const length = readVarUint(decoder);
	if (decoder.pos + length > decoder.arr.length)
		throw new Error("Unexpected end of array");
	const cached = readStrings[slot];
	if (cached?.bytes.length === length) {
		let same = true;
		for (let i = 0; i < length; i++)
			if (decoder.arr[decoder.pos + i] !== cached.bytes[i]) {
				same = false;
				break;
			}
		if (same) {
			decoder.pos += length;
			return cached.value;
		}
	}
	const content = decoder.pos;
	decoder.pos = start;
	const value = readVarString(decoder);
	if (length <= maxCachedStringBytes)
		readStrings[slot] = {
			value,
			bytes: new Uint8Array(decoder.arr.subarray(content, decoder.pos)),
		};
	return value;
}
type EncodedValue = {
	layout: number;
	data: Uint8Array;
	constants: string[][];
	texts: string[][];
};
function writePaths(encoder: Encoder, paths: string[][]): void {
	writeVarUint(encoder, paths.length);
	for (const path of paths) {
		writeVarUint(encoder, path.length);
		for (const key of path) writeVarString(encoder, key);
	}
}
function readPaths(decoder: Decoder): string[][] {
	const count = readVarUint(decoder);
	const paths: string[][] = [];
	for (let i = 0; i < count; i++) {
		const length = readVarUint(decoder),
			path: string[] = [];
		for (let j = 0; j < length; j++) path.push(readVarString(decoder));
		paths.push(path);
	}
	return paths;
}
/** Keep the common register write in its existing wire format without wrapper objects. */
function encodeSingleSet(
	patch: CorePatch,
	op: Extract<CoreOperation, { kind: 1 }>,
	encoding: ValueEncoding,
): Uint8Array<ArrayBuffer> {
	const encoded = encoding.encode(op.value, op);
	const encoder = patchEncoder;
	encoder.pos = 0;
	writeVarUint(encoder, OPERATIONS_VERSION);
	writeVarUint(encoder, patch.lamport);
	writePatchString(encoder, patch.schema, 0);
	writeVarUint(encoder, 1);
	writeVarUint(encoder, op.last ? 7 : 1);
	writePatchString(encoder, op.target, 1);
	if (typeof op.field === "string") {
		writeVarUint(encoder, 0);
		writePatchString(encoder, op.field, 2);
	} else {
		if (!Number.isSafeInteger(op.field) || op.field < 0)
			throw new TypeError("Invalid field slot");
		writeVarUint(encoder, 1);
		writeVarUint(encoder, op.field);
	}
	writeVarUint(encoder, encoded.layout);
	writeVarUint8Array(encoder, encoded.data);
	writePaths(encoder, op.value.constants);
	writePaths(encoder, op.value.texts);
	return toUint8Array(encoder);
}
/** Decode a common write directly; uncommon operations use the schema compiler. */
function decodePatch(decoder: Decoder): ReturnType<typeof codec.decode> {
	const version = readVarUint(decoder),
		lamport = readVarUint(decoder),
		schema = readPatchString(decoder, 0);
	const kind = readVarUint(decoder) === 1 ? readVarUint(decoder) : 0;
	if (kind === 1 || kind === 7) {
		const target = readPatchString(decoder, 1),
			fieldKind = readVarUint(decoder);
		if (fieldKind > 1)
			throw new PulseError("INVALID_MESSAGE", "Invalid field variant");
		const field =
			fieldKind === 0 ? readPatchString(decoder, 2) : readVarUint(decoder);
		const value: EncodedValue = {
			layout: readVarUint(decoder),
			data: readVarUint8Array(decoder),
			constants: readPaths(decoder),
			texts: readPaths(decoder),
		};
		return {
			version,
			lamport,
			schema,
			ops: [{ kind, target, field, value }],
		};
	}
	decoder.pos = 0;
	return codec.decode(decoder);
}
const generic = createCodec("unknown");
export type ValueEncoding = {
	encode(
		value: PreparedValue,
		op: CoreOperation,
	): { layout: number; data: Uint8Array };
	decode(layout: number, data: Uint8Array): unknown;
};
const fallback: ValueEncoding = {
	encode: (value) => ({ layout: 0, data: generic.encode(value.value) }),
	decode: (layout, data) => {
		if (layout !== 0)
			throw new PulseError(
				"INCOMPATIBLE_DOCUMENT",
				"A typed schema is required",
			);
		const decoder = createDecoder(data);
		const value = generic.decode(decoder);
		if (decoder.pos !== data.length)
			throw new PulseError("INVALID_MESSAGE", "Trailing value bytes");
		return value;
	},
};
export function encodeCorePatch(
	patch: CorePatch,
	encoding = fallback,
): Uint8Array<ArrayBuffer> {
	if (
		patch.ops.length === 1 &&
		patch.ops[0]!.kind === 1 &&
		patch.time === undefined
	) {
		const bytes = encodeSingleSet(
			patch,
			patch.ops[0] as Extract<CoreOperation, { kind: 1 }>,
			encoding,
		);
		if (bytes.length > MAX_PATCH_BYTES)
			throw new PulseError("LIMIT_EXCEEDED", "Patch payload exceeds 1 MiB");
		return bytes;
	}
	const value = (prepared: PreparedValue, op: CoreOperation) => ({
		...encoding.encode(prepared, op),
		constants: prepared.constants,
		texts: prepared.texts,
	});
	const ops: Parameters<typeof codec.encode>[0]["ops"] = patch.ops.map((op) => {
		if (op.kind === 1) {
			const { last, ...write } = op;
			return last
				? { ...write, kind: 7, value: value(op.value, op) }
				: { ...write, value: value(op.value, op) };
		}
		if (op.kind === 2) {
			const { last, ...removal } = op;
			return last ? { ...removal, kind: 8 } : removal;
		}
		if (op.kind === 0 || op.kind === 4)
			return { ...op, value: value(op.value, op) };
		if (op.kind === 3)
			return { ...op, values: op.values.map((v) => value(v, op)) };
		if (op.kind === 5 && op.count !== undefined)
			return {
				kind: 11,
				target: op.target,
				first: op.entries[0]!,
				count: op.count,
				attributes: op.attributes,
			};
		if (op.kind === 12)
			return {
				kind: 12,
				target: op.target,
				after: op.after,
				text: op.text,
				attributes: op.attributes ?? null,
			};
		return op;
	});
	if (patch.time !== undefined) ops.push({ kind: 9, time: patch.time });
	const bytes = codec.encode({
		version: OPERATIONS_VERSION,
		lamport: patch.lamport,
		schema: patch.schema,
		ops,
	});
	if (bytes.length > MAX_PATCH_BYTES)
		throw new PulseError("LIMIT_EXCEEDED", "Patch payload exceeds 1 MiB");
	return bytes;
}
export function decodeCorePatch(
	row: PulsePatchRow,
	encoding: ValueEncoding | ((schema: string) => ValueEncoding) = fallback,
	schema?: string,
): CorePatch {
	try {
		if (row.operations.length > MAX_PATCH_BYTES)
			throw new PulseError("LIMIT_EXCEEDED", "Patch payload exceeds 1 MiB");
		// A span above one also covers replaced writes that followed this one.
		if (isGap(row.operations))
			return new CorePatch(row.sid, row.clock, 1, "", []);
		const decoder = createDecoder(row.operations);
		const decoded = decodePatch(decoder);
		if (
			decoder.pos !== row.operations.length ||
			decoded.version !== OPERATIONS_VERSION ||
			row.span < 1 ||
			!decoded.ops.length ||
			!Number.isSafeInteger(decoded.lamport) ||
			decoded.lamport < 1
		)
			throw new PulseError("INVALID_MESSAGE", "Invalid core patch");
		if (schema !== undefined && decoded.schema !== schema)
			throw new PulseError(
				"INCOMPATIBLE_DOCUMENT",
				"Patch schema does not match the pulse definition",
			);
		const valueEncoding =
			typeof encoding === "function" ? encoding(decoded.schema) : encoding;
		const value = (v: {
			layout: number;
			data: Uint8Array;
			constants: string[][];
			texts: string[][];
		}): PreparedValue => {
			const result = {
				value: v.layout
					? valueEncoding.decode(v.layout, v.data)
					: prepareValue(valueEncoding.decode(v.layout, v.data)).value,
				constants: v.constants,
				texts: v.texts,
			};
			if (result.constants.length || result.texts.length)
				validatePrepared(result);
			return result;
		};
		let time: number | undefined;
		const operation = (op: (typeof decoded.ops)[number]): CoreOperation => {
			if (op.kind === 1)
				return {
					kind: 1,
					target: op.target,
					field: op.field,
					value: value(op.value),
				};
			if (op.kind === 7)
				return {
					kind: 1,
					target: op.target,
					field: op.field,
					value: value(op.value),
					last: true,
				};
			if (op.kind === 8)
				return { kind: 2, target: op.target, field: op.field, last: true };
			if (op.kind === 9) throw new PulseError("INVALID_MESSAGE", "Stray time");
			if (op.kind === 0 || op.kind === 4)
				return { ...op, value: value(op.value) };
			if (op.kind === 3) return { ...op, values: op.values.map(value) };
			if (op.kind === 11)
				return {
					kind: 5,
					target: op.target,
					entries: [op.first],
					count: op.count,
					attributes: prepareValue(op.attributes).value as Record<
						string,
						unknown
					>,
				};
			if (op.kind === 12) {
				const attrs =
					op.attributes === null || op.attributes === undefined
						? undefined
						: (prepareValue(op.attributes).value as Record<string, unknown>);
				return {
					kind: 12,
					target: op.target,
					after: op.after,
					text: op.text,
					...(attrs ? { attributes: attrs } : {}),
				};
			}
			if (op.kind === 5)
				return {
					...op,
					attributes: prepareValue(op.attributes).value as Record<
						string,
						unknown
					>,
				};
			return op as CoreOperation;
		};
		// The time of a transaction is its last operation, and never its only one.
		const stamped = decoded.ops[decoded.ops.length - 1]!;
		if (stamped.kind === 9) {
			time = stamped.time;
			decoded.ops.pop();
			if (!decoded.ops.length || !Number.isSafeInteger(time))
				throw new PulseError("INVALID_MESSAGE", "Invalid transaction time");
		}
		const ops =
			decoded.ops.length === 1
				? [operation(decoded.ops[0]!)]
				: decoded.ops.map(operation);
		return new CorePatch(
			row.sid,
			row.clock,
			decoded.lamport,
			decoded.schema,
			ops,
			time,
		);
	} catch (error) {
		if (error instanceof PulseError) throw error;
		throw new PulseError("INVALID_MESSAGE", "Cannot decode core patch", {
			cause: error,
		});
	}
}
// Relays validate the envelope without knowing the application schema or decoding values.
export function validateCoreRow(row: PulsePatchRow): void {
	if (isGap(row.operations)) return;
	const decoder = createDecoder(row.operations);
	const decoded = codec.decode(decoder);
	if (
		decoder.pos !== row.operations.length ||
		decoded.version !== OPERATIONS_VERSION ||
		row.span < 1 ||
		!decoded.ops.length ||
		!Number.isSafeInteger(decoded.lamport) ||
		decoded.lamport < 1
	)
		throw new PulseError("INVALID_MESSAGE", "Invalid core patch");
}
