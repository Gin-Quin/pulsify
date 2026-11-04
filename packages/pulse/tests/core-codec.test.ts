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
				version: 2,
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
