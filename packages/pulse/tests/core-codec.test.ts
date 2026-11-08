import { expect, test } from "bun:test";
import { array, createCodec, object, union } from "@gin-quin/codec";
import {
	CorePatch,
	decodeCorePatch,
	encodeCorePatch,
} from "../source/core/operations";
import { prepareValue, type PreparedValue } from "../source/core/values";

// The schema-compiled representation is also the independent relay's format.
const valueSchema = object({
	layout: "uint",
	data: "uint8Array",
	constants: array(array("string")),
	texts: array(array("string")),
});
const reference = createCodec(
	object({
		version: "uint",
		lamport: "uint",
		schema: "string",
		ops: array(
			union({
				tagName: "kind",
				tagType: "uint",
				variants: {
					1: {
						target: "string",
						field: union(["string", "uint"]),
						value: valueSchema,
					},
				},
			}),
		),
	}),
);
const generic = createCodec("unknown");

test("single register writes preserve schema-compiled bytes and strict decoding", () => {
	const values: PreparedValue[] = [
		...[-0, 1.25, "é🌍", undefined, null, new Uint8Array([0, 255])].map(
			prepareValue,
		),
		{
			value: { frozen: [1, 2], text: "hello" },
			constants: [["frozen"]],
			texts: [["text"]],
		},
	];
	for (const field of [0, 128, "title"])
		for (const value of values) {
			const op = { kind: 1 as const, target: "65536:1:0", field, value };
			const patch = new CorePatch(65536, 128, 1024, "schema🌍", [op]);
			const expected = reference.encode({
				version: 3,
				lamport: patch.lamport,
				schema: patch.schema,
				ops: [
					{
						...op,
						value: {
							layout: 0,
							data: generic.encode(value.value),
							constants: value.constants,
							texts: value.texts,
						},
					},
				],
			});
			const actual = encodeCorePatch(patch);
			expect(actual).toEqual(expected);
			const row = {
				docId: "codec",
				sid: patch.sid,
				clock: patch.clock,
				span: 1,
				dependencies: [],
				operations: actual,
			};
			expect(decodeCorePatch(row).ops).toEqual(patch.ops);
			for (let length = 0; length < actual.length; length++)
				expect(() =>
					decodeCorePatch({ ...row, operations: actual.subarray(0, length) }),
				).toThrow();
			expect(() =>
				decodeCorePatch({ ...row, operations: new Uint8Array([...actual, 0]) }),
			).toThrow();
		}
});

test("single register writes reject invalid numeric field slots before encoding", () => {
	for (const field of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
		expect(() =>
			encodeCorePatch(
				new CorePatch(65536, 1, 1, "", [
					{ kind: 1, target: "65536:1:0", field, value: prepareValue(1) },
				]),
			),
		).toThrow();
});

test("repeated register headers remain byte-exact across cache hits, changes and oversized strings", () => {
	for (const header of [
		"same-header",
		"same-header",
		"next-header",
		"e\u0301🌍",
		"é🌍",
		"x".repeat(2048),
		"same-header",
	]) {
		const value = prepareValue(header);
		const op = { kind: 1 as const, target: header, field: header, value };
		const patch = new CorePatch(65536, 1, 1, header, [op]);
		const expected = reference.encode({
			version: 3,
			lamport: 1,
			schema: header,
			ops: [
				{
					...op,
					value: {
						layout: 0,
						data: generic.encode(header),
						constants: [],
						texts: [],
					},
				},
			],
		});
		const actual = encodeCorePatch(patch);
		expect(actual).toEqual(expected);
		const row = {
			docId: "cache",
			sid: 65536,
			clock: 1,
			span: 1,
			dependencies: [],
			operations: actual,
		};
		for (let repeat = 0; repeat < 2; repeat++) {
			const decoded = decodeCorePatch(row);
			expect(decoded.schema).toBe(header);
			expect(decoded.ops).toEqual([op]);
		}
	}
});

test("register header caches own Buffer bytes and compare every byte", () => {
	const packet = (header: string) =>
		encodeCorePatch(
			new CorePatch(65536, 1, 1, header, [
				{ kind: 1, target: header, field: header, value: prepareValue(1) },
			]),
		);
	const original = packet("cache-A"),
		replacement = packet("cache-B");
	const buffer = Buffer.from(original);
	const row = {
		docId: "cache",
		sid: 65536,
		clock: 1,
		span: 1,
		dependencies: [],
		operations: buffer,
	};
	const first = decodeCorePatch(row);
	buffer.set(replacement);
	const second = decodeCorePatch(row);
	expect(first.schema).toBe("cache-A");
	expect(second.schema).toBe("cache-B");
	expect(second.ops[0]).toEqual({
		kind: 1,
		target: "cache-B",
		field: "cache-B",
		value: prepareValue(1),
	});
	buffer.fill(0);
	expect(
		decodeCorePatch({ ...row, operations: Buffer.from(original) }).schema,
	).toBe("cache-A");
});

test("warm register caches still reject truncated lengths and invalid field variants", () => {
	for (const field of ["cached-field", 0, "cached-field", 128]) {
		const patch = new CorePatch(65536, 1, 1, "cached-schema", [
			{ kind: 1, target: "cached-target", field, value: prepareValue(1) },
		]);
		const bytes = encodeCorePatch(patch);
		const row = {
			docId: "cache",
			sid: 65536,
			clock: 1,
			span: 1,
			dependencies: [],
			operations: bytes,
		};
		expect(decodeCorePatch(row).ops).toEqual(patch.ops);
		for (let length = 0; length < bytes.length; length++)
			expect(() =>
				decodeCorePatch({ ...row, operations: bytes.subarray(0, length) }),
			).toThrow();
		const invalidField = bytes.slice();
		// version, Lamport, schema, operation count/kind, target, field tag.
		invalidField[2 + 1 + patch.schema.length + 2 + 1 + "cached-target".length] =
			2;
		expect(() => decodeCorePatch({ ...row, operations: invalidField })).toThrow(
			"field variant",
		);
		for (const prefix of [
			[0x80],
			[0xff, 0xff, 0x7f],
			[0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f],
		])
			expect(() =>
				decodeCorePatch({
					...row,
					operations: new Uint8Array([3, 1, ...prefix]),
				}),
			).toThrow();
	}
});
