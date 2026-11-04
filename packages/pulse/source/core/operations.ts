import {
	array,
	createCodec,
	object,
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
export type CoreOperation =
	| { kind: 0; value: PreparedValue }
	| { kind: 1; target: string; field: CoreField; value: PreparedValue }
	| { kind: 2; target: string; field: CoreField }
	| {
			kind: 3;
			target: string;
			after: string;
			deletes: string[];
			values: PreparedValue[];
	  }
	| { kind: 4; target: string; entry: string; value: PreparedValue }
	| {
			kind: 5;
			target: string;
			entries: string[];
			attributes: Record<string, unknown>;
	  };
export class CorePatch {
	constructor(
		public readonly sid: number,
		public readonly clock: number,
		public readonly lamport: number,
		public readonly schema: string,
		private body: CoreOperation[] | undefined,
	) {}
	get ops(): CoreOperation[] {
		return (this.body ??= this.createOperations());
	}
	protected createOperations(): CoreOperation[] {
		return [];
	}
	getId() {
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
	},
});
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
	writeVarUint(encoder, 2);
	writeVarUint(encoder, patch.lamport);
	writePatchString(encoder, patch.schema, 0);
	writeVarUint(encoder, 1);
	writeVarUint(encoder, 1);
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
	if (readVarUint(decoder) === 1 && readVarUint(decoder) === 1) {
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
			ops: [{ kind: 1, target, field, value }],
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
	if (patch.ops.length === 1 && patch.ops[0]!.kind === 1) {
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
	const ops = patch.ops.map((op) => {
		if (op.kind === 0 || op.kind === 1 || op.kind === 4)
			return { ...op, value: value(op.value, op) };
		if (op.kind === 3)
			return { ...op, values: op.values.map((v) => value(v, op)) };
		return op;
	});
	const bytes = codec.encode({
		version: 2,
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
		const decoder = createDecoder(row.operations);
		const decoded = decodePatch(decoder);
		if (
			decoder.pos !== row.operations.length ||
			decoded.version !== 2 ||
			row.span !== 1 ||
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
		const operation = (op: (typeof decoded.ops)[number]): CoreOperation => {
			if (op.kind === 1)
				return {
					kind: 1,
					target: op.target,
					field: op.field,
					value: value(op.value),
				};
			if (op.kind === 0 || op.kind === 4)
				return { ...op, value: value(op.value) };
			if (op.kind === 3) return { ...op, values: op.values.map(value) };
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
	const decoder = createDecoder(row.operations);
	const decoded = codec.decode(decoder);
	if (
		decoder.pos !== row.operations.length ||
		decoded.version !== 2 ||
		row.span !== 1 ||
		!decoded.ops.length ||
		!Number.isSafeInteger(decoded.lamport) ||
		decoded.lamport < 1
	)
		throw new PulseError("INVALID_MESSAGE", "Invalid core patch");
}
