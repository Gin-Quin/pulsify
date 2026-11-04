import {
	type ArraySchema,
	type TupleSchema,
	type InferType,
	type UnionSchema,
	array,
	optional,
	tuple,
	union,
} from "@gin-quin/codec";
import {
	decode as decodeVerbose,
	encode as encodeVerbose,
	type JsonCodecOperation,
} from "json-joy/lib/json-crdt-patch/codec/verbose/index.js";
import type { Patch } from "json-joy/lib/json-crdt-patch/Patch.js";
import { wireCodec } from "../protocol/wireCodec.js";
import { PulseError } from "../protocol/errors.js";
import { MAX_PATCH_BYTES } from "../protocol/chunkRows.js";
import type { PulseVersionVector } from "./PulseVersionVector.js";
import { assertProperty } from "../pulses/PulseObject.js";

// A fixed value vocabulary, rather than executable or self-describing schemas.
// Rust relays need not inspect this inner payload.
type ValueSchema = UnionSchema<
	"uint",
	{
		0: {};
		1: {};
		2: { value: "boolean" };
		3: { value: "float64" };
		4: { value: "string" };
		5: { items: ArraySchema<() => ValueSchema> };
		6: { entries: ArraySchema<TupleSchema<["string", () => ValueSchema]>> };
		7: { value: "uint8Array" };
	},
	"kind"
>;
const valueSchema: ValueSchema = union({
	tagName: "kind",
	tagType: "uint",
	variants: {
		0: {},
		1: {},
		2: { value: "boolean" },
		3: { value: "float64" },
		4: { value: "string" },
		5: { items: array(() => valueSchema) },
		6: { entries: array(tuple("string", () => valueSchema)) },
		7: { value: "uint8Array" },
	},
});
type PortableValue = InferType<ValueSchema>;

function pack(
	value: unknown,
	ancestors = new Set<object>(),
	depth = 0,
): PortableValue {
	if (depth > 32)
		throw new PulseError(
			"INVALID_MESSAGE",
			"Constant nesting exceeds 32 levels",
		);
	if (value === null) return { kind: 0 };
	if (value === undefined) return { kind: 1 };
	if (typeof value === "boolean") return { kind: 2, value };
	if (typeof value === "number" && Number.isFinite(value))
		return { kind: 3, value };
	if (typeof value === "string") return { kind: 4, value };
	if (value instanceof Uint8Array) return { kind: 7, value };
	if (typeof value !== "object" || !value)
		throw new PulseError("INVALID_MESSAGE", "Unsupported constant value");
	if (ancestors.has(value))
		throw new PulseError("INVALID_MESSAGE", "Cyclic constant");
	ancestors.add(value);
	try {
		if (Array.isArray(value))
			return {
				kind: 5,
				items: value.map((item) => pack(item, ancestors, depth + 1)),
			};
		if (
			Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null
		)
			throw new PulseError(
				"INVALID_MESSAGE",
				"Constant must be a plain object",
			);
		return {
			kind: 6,
			entries: Object.entries(value).map(([key, item]) => [
				key,
				pack(item, ancestors, depth + 1),
			]),
		};
	} finally {
		ancestors.delete(value);
	}
}
function unpack(value: PortableValue): unknown {
	switch (value.kind) {
		case 0:
			return null;
		case 1:
			return undefined;
		case 2:
		case 3:
		case 4:
			return value.value;
		case 7:
			return value.value.slice();
		case 5:
			return value.items.map(unpack);
		case 6: {
			const object: Record<string, unknown> = {};
			for (const [key, item] of value.entries) {
				if (Object.hasOwn(object, key))
					throw new PulseError("INVALID_MESSAGE", "Duplicate constant key");
				Object.defineProperty(object, key, {
					value: unpack(item),
					enumerable: true,
					writable: true,
					configurable: true,
				});
			}
			return object;
		}
	}
}

export const JsonCodecTimestampSchema = union([tuple("uint", "uint"), "uint"]);
export const JsonCodecTimespanSchema = tuple("uint", "uint", "uint");
export const JsonCodecOperationSchema = union({
	tagName: "op",
	tagType: "string",
	variants: {
		new_con: { value: optional(valueSchema), timestamp: optional("boolean") },
		new_val: {},
		new_obj: {},
		new_vec: {},
		new_str: {},
		new_bin: {},
		new_arr: {},
		ins_val: { obj: JsonCodecTimestampSchema, value: JsonCodecTimestampSchema },
		ins_obj: {
			obj: JsonCodecTimestampSchema,
			value: array(tuple("string", JsonCodecTimestampSchema)),
		},
		ins_vec: {
			obj: JsonCodecTimestampSchema,
			value: array(tuple("uint", JsonCodecTimestampSchema)),
		},
		ins_str: {
			obj: JsonCodecTimestampSchema,
			after: JsonCodecTimestampSchema,
			value: "string",
		},
		ins_bin: {
			obj: JsonCodecTimestampSchema,
			after: JsonCodecTimestampSchema,
			value: "string",
		},
		ins_arr: {
			obj: JsonCodecTimestampSchema,
			after: JsonCodecTimestampSchema,
			values: array(JsonCodecTimestampSchema),
		},
		upd_arr: {
			obj: JsonCodecTimestampSchema,
			ref: JsonCodecTimestampSchema,
			value: JsonCodecTimestampSchema,
		},
		del: {
			obj: JsonCodecTimestampSchema,
			what: array(JsonCodecTimespanSchema),
		},
		nop: { len: optional("uint") },
	},
});
export type InferredJsonCodecOperation = InferType<
	typeof JsonCodecOperationSchema
>;
const operationsCodec = wireCodec(array(JsonCodecOperationSchema));

export type PulsePatch = {
	docId: string;
	sid: number;
	clock: number;
	span: number;
	dependencies: PulseVersionVector;
	operations: JsonCodecOperation[];
};
export type PulsePatchRow = Omit<PulsePatch, "operations"> & {
	operations: Uint8Array;
};

export function encodeOperations(
	operations: JsonCodecOperation[],
): Uint8Array<ArrayBuffer> {
	const bytes = operationsCodec.encode(
		operations.map((op) =>
			op.op === "new_con" ? { ...op, value: pack(op.value) } : op,
		),
	);
	if (bytes.length > MAX_PATCH_BYTES)
		throw new PulseError("LIMIT_EXCEEDED", "Patch payload exceeds 1 MiB");
	return bytes;
}
export function decodeOperations(bytes: Uint8Array): JsonCodecOperation[] {
	if (bytes.length > MAX_PATCH_BYTES)
		throw new PulseError("LIMIT_EXCEEDED", "Patch payload exceeds 1 MiB");
	return operationsCodec.decode(bytes).map((op) => {
		if (op.op === "nop")
			return op.len === undefined ? { op: "nop" } : { op: "nop", len: op.len };
		if (op.op === "new_con")
			return {
				op: "new_con",
				value: op.value === undefined ? undefined : unpack(op.value),
				...(op.timestamp === undefined ? {} : { timestamp: op.timestamp }),
			};
		return op;
	});
}
export function patchToRow(
	docId: string,
	patch: Patch,
	dependencies: PulseVersionVector,
): PulsePatchRow {
	const verbose = encodeVerbose(patch);
	return {
		docId,
		sid: verbose.id[0],
		clock: verbose.id[1],
		span: patch.span(),
		dependencies,
		operations: encodeOperations(verbose.ops),
	};
}
export function rowToPatch(row: PulsePatchRow): Patch {
	const ops = decodeOperations(row.operations);
	for (const op of ops) {
		if (op.op === "ins_obj") for (const [key] of op.value) assertProperty(key);
		if (op.op === "nop" && op.len === 0)
			throw new PulseError("INVALID_MESSAGE", "Empty nop");
		if (op.op === "new_con" && op.timestamp) {
			const v = op.value;
			if (
				!(Number.isSafeInteger(v) && (v as number) >= 0) &&
				!(
					Array.isArray(v) &&
					v.length === 2 &&
					v.every((n) => Number.isSafeInteger(n) && n >= 0)
				)
			)
				throw new PulseError("INVALID_MESSAGE", "Invalid timestamp constant");
		}
		if (
			op.op === "ins_bin" &&
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
				op.value,
			)
		)
			throw new PulseError("INVALID_MESSAGE", "Invalid base64");
		if (op.op === "del" && op.what.some(([, , span]) => span === 0))
			throw new PulseError("INVALID_MESSAGE", "Empty deletion span");
		if (op.op === "ins_vec" && op.value.some(([index]) => index > 255))
			throw new PulseError("INVALID_MESSAGE", "Vector index exceeds 255");
	}
	const patch = decodeVerbose({ id: [row.sid, row.clock], ops });
	if (
		!patch.ops.length ||
		patch.ops.length !== ops.length ||
		patch.span() !== row.span
	)
		throw new PulseError("INVALID_MESSAGE", "Patch span mismatch");
	const dependencies = new Map(row.dependencies);
	for (let i = 0; i < ops.length; i++) {
		const op = ops[i]!;
		const references: Array<number | [number, number]> = [];
		if ("obj" in op) references.push(op.obj);
		if ("after" in op) references.push(op.after);
		if ("ref" in op) references.push(op.ref);
		if (op.op === "ins_val" || op.op === "upd_arr") references.push(op.value);
		if (op.op === "ins_arr")
			for (const value of op.values) references.push(value);
		if (op.op === "ins_obj" || op.op === "ins_vec")
			for (const [, value] of op.value) references.push(value);
		if (op.op === "del")
			for (const [sid, time, span] of op.what) {
				if (!Number.isSafeInteger(time + span))
					throw new PulseError("INVALID_MESSAGE", "Deletion range overflow");
				references.push([sid, time + span - 1]);
			}
		for (const ref of references) {
			const [sid, time] = typeof ref === "number" ? [1, ref] : ref;
			if (sid === 0 && time === 0) continue;
			if (sid === row.sid && time >= row.clock && time < patch.ops[i]!.id.time)
				continue;
			if ((dependencies.get(sid) ?? 0) <= time)
				throw new PulseError(
					"INVALID_MESSAGE",
					"Operation reference is not causally covered",
				);
		}
	}
	return patch;
}
