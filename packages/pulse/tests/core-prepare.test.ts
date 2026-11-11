import { describe, expect, test } from "bun:test";
import {
	bigint,
	createCodec,
	literal,
	map,
	object,
	optional,
	union,
} from "@gin-quin/codec";
import { compilePulseSchema } from "../source/core/schema.js";
import { prepareValue, validatePrepared } from "../source/core/values.js";
import { richText } from "../source/core/richText.js";

describe("single-pass compiled preparation", () => {
	test("marker lists preserve input DFS order while object values use schema order", () => {
		const schema = object({
			first: object({ text: "string", fixed: object({ value: "uint" }) }),
			second: object({ text: "string", fixed: object({ value: "uint" }) }),
			fallback: union([object({ body: "string" }), "null"]),
			dynamic: "unknown",
		});
		const input = {
			dynamic: { z: richText("Z"), a: { value: 1 } },
			second: { text: richText("Second"), fixed: { value: 2 } },
			fallback: { body: richText("Fallback") },
			first: { fixed: { value: 1 }, text: richText("First") },
		};
		const compiled = compilePulseSchema(schema);
		const original = prepareValue(input);
		const validated = compiled.assert(original.value);
		const previous = { ...original, value: compiled.clone(validated) };
		validatePrepared(previous);
		const next = compiled.prepare(input);
		expect(next.value).toEqual(previous.value);
		expect(Object.keys(next.value as object)).toEqual([
			"first",
			"second",
			"fallback",
			"dynamic",
		]);
		expect(next.constants).toEqual(previous.constants);
		expect(next.texts).toEqual(previous.texts);
		expect(next.constants).toEqual([]);
		expect(next.texts).toEqual([
			["dynamic", "z"],
			["second", "text"],
			["fallback", "body"],
			["first", "text"],
		]);
	});

	test("tagged union discriminants and ordinary fields are read only once", () => {
		const schema = union({
			tagName: "kind",
			tagType: "string",
			variants: { note: { body: "string", values: map("uint") } },
		});
		let tags = 0,
			bodies = 0,
			entries = 0;
		const values = Object.defineProperty({}, "entry", {
			enumerable: true,
			get() {
				entries++;
				return 3;
			},
		});
		const input = Object.defineProperties(
			{},
			{
				body: {
					enumerable: true,
					get() {
						bodies++;
						return "Body";
					},
				},
				values: { enumerable: true, value: values },
				kind: {
					enumerable: true,
					get() {
						tags++;
						return "note";
					},
				},
			},
		);
		expect(compilePulseSchema(schema).prepare(input).value).toEqual({
			kind: "note",
			body: "Body",
			values: { entry: 3 },
		});
		expect({ tags, bodies, entries }).toEqual({
			tags: 1,
			bodies: 1,
			entries: 1,
		});
	});

	test("empty object layouts validate discarded extras and reject discarded markers", () => {
		const compiled = compilePulseSchema(object({}));
		expect(compiled.prepare({ extra: { value: 1 } }).value).toEqual({});
		expect(() => compiled.prepare({ extra: () => 1 })).toThrow();
		expect(() => compiled.prepare({ extra: richText("discarded") })).toThrow(
			"missing path",
		);
		expect(() => compiled.prepare({ ["constructor"]: 1 })).toThrow(
			"Unsupported property",
		);
	});

	test("fallback root markers are emitted once and binary aliases detach independently", () => {
		expect(
			compilePulseSchema("unknown").prepare(richText("Text")).texts,
		).toEqual([[]]);
		const shared = new Uint8Array([9, 1, 2, 8]).subarray(1, 3);
		const prepared = compilePulseSchema(
			object({ left: "uint8Array", right: "uint8Array" }),
		).prepare({ right: shared, left: shared });
		const value = prepared.value as { left: Uint8Array; right: Uint8Array };
		expect(value.left).toEqual(new Uint8Array([1, 2]));
		expect(value.left).not.toBe(value.right);
		expect(value.left).not.toBe(shared);
		value.left[0] = 99;
		expect(value.right[0]).toBe(1);
		expect(shared[0]).toBe(1);
	});

	test("normalization canonicalizes input negative zero before float32 rounding", () => {
		const compiled = compilePulseSchema("float32");
		const codec = createCodec("float32");
		const zero = compiled.prepare(-0).value as number;
		const tiny = compiled.prepare(-1e-60).value as number;
		expect(Object.is(zero, 0)).toBe(true);
		expect(Object.is(tiny, -0)).toBe(true);
		expect(codec.encode(zero)).toEqual(codec.encode(0));
		expect(codec.encode(tiny)).toEqual(codec.encode(-0));
	});

	test("integer clones canonicalize negative zero exactly like each integer codec", () => {
		for (const schema of [
			"int",
			"int32",
			"int64",
			"uint",
			"uint32",
			"uint64",
		] as const) {
			const compiled = compilePulseSchema(schema);
			const expected = compiled.codec.decode(compiled.codec.encode(-0));
			expect(Object.is(compiled.clone(-0), 0)).toBe(true);
			expect(Object.is(compiled.root.clone(-0), expected)).toBe(true);
		}
		expect(Object.is(compilePulseSchema("float32").clone(-0), -0)).toBe(true);
	});

	test("shallow checks defer child validation but keep leaf and atomic guarantees", () => {
		const compiled = compilePulseSchema(
			object({ count: "uint", child: optional(object({ label: "string" })) }),
		);
		expect(compiled.root.assertShallow({ count: "invalid child" })).toEqual({
			count: "invalid child",
		});
		expect(() =>
			compiled.fieldAt(["count"])!.layout.assertShallow("invalid child"),
		).toThrow();
		class RecordClass {
			count = 1;
		}
		expect(() => compiled.root.assertShallow(new RecordClass())).toThrow();
		expect(() =>
			compilePulseSchema(literal({ count: 1 })).root.assertShallow({
				count: 2,
			}),
		).toThrow();
		expect(() =>
			compilePulseSchema(
				union([object({ count: "uint" }), "null"]),
			).root.assertShallow({ count: "invalid" }),
		).toThrow();
		expect(() =>
			compilePulseSchema(bigint(1)).root.assertShallow(1000n),
		).toThrow();
		expect(
			compiled.fieldAt(["child"])!.layout.assertShallow(undefined),
		).toBeUndefined();
	});
});
