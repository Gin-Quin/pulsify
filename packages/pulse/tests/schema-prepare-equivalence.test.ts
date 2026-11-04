import { describe, expect, test } from "bun:test";
import {
	array,
	bigint,
	literal,
	map,
	object,
	optional,
	set,
	tuple,
	union,
	type Schema,
} from "@gin-quin/codec";
import { richText } from "../source/core/richText.js";
import { compilePulseSchema, type PulseLayout } from "../source/core/schema.js";
import {
	prepareValue,
	RichTextSymbol,
	validatePrepared,
	type PreparedValue,
} from "../source/core/values.js";
import { struct } from "../source/utilities/Struct.js";
import { tuple as constantTuple } from "../source/utilities/Tuple.js";

/** The previous mutation pipeline is intentionally kept independent of prepare. */
function reference(
	layout: PulseLayout,
	input: unknown,
	initialDepth = 0,
): PreparedValue {
	let wrapped = input;
	for (let i = 0; i < initialDepth; i++) wrapped = [wrapped];
	const prepared = prepareValue(wrapped);
	for (let i = 0; i < initialDepth; i++)
		prepared.value = (prepared.value as unknown[])[0];
	prepared.constants = prepared.constants.map((path) =>
		path.slice(initialDepth),
	);
	prepared.texts = prepared.texts.map((path) => path.slice(initialDepth));
	layout.assert(prepared.value);
	const result = { ...prepared, value: layout.clone(prepared.value) };
	validatePrepared(result);
	return result;
}

function markers(paths: readonly string[][]): string[] {
	return [...new Set(paths.map((path) => JSON.stringify(path)))].sort();
}

function outcome(run: () => PreparedValue) {
	try {
		return { result: run(), error: undefined };
	} catch (error) {
		return { result: undefined, error };
	}
}

function equivalent(
	layout: PulseLayout,
	input: unknown,
	initialDepth = 0,
): void {
	const old = outcome(() => reference(layout, input, initialDepth));
	const next = outcome(() => layout.prepare(input, initialDepth));
	expect(next.error === undefined).toBe(old.error === undefined);
	if (old.error) {
		expect(next.error).toBeInstanceOf((old.error as Error).constructor);
		return;
	}
	expect(next.result!.value).toEqual(old.result!.value);
	expect(markers(next.result!.constants)).toEqual(
		markers(old.result!.constants),
	);
	expect(markers(next.result!.texts)).toEqual(markers(old.result!.texts));
}

describe("compiled preparation matches the previous mutation pipeline", () => {
	test("primitive boundaries, bigint, binary and float32 normalization", () => {
		const cases: readonly [Schema, readonly unknown[]][] = [
			[
				"float64",
				[0, -0, 1 / 3, Number.MAX_VALUE, Infinity, -Infinity, NaN, "1"],
			],
			["float32", [-0, 1 / 3, -1e-100, 1e100, Infinity, NaN]],
			["uint", [0, -0, 9, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 1n]],
			["int32", [-123, 0, -0, 123, 0.1, Infinity]],
			["string", ["", "a🌍\u0000", "\ud800", "\udfff", 3, richText("text")]],
			["boolean", [true, false, 1, "false", undefined]],
			["undefined", [undefined, null]],
			["null", [null, undefined]],
			[
				"schema",
				[
					"string",
					object({ value: "uint" }),
					{ _type: "array", element: "uint" },
					() => "string",
				],
			],
			[bigint(2), [0n, -1n, 255n, 1n << 40n, 1]],
			[
				"uint8Array",
				[
					new Uint8Array(),
					new Uint8Array([0, 128, 255]),
					[1, 2],
					new Uint16Array([1]),
				],
			],
			["date", [new Date(0), new Date(NaN), "2026-01-01"]],
			[set("string"), [new Set(["a"]), ["a"]]],
		];
		for (const [schema, values] of cases) {
			const layout = compilePulseSchema(schema).root;
			for (const value of values) equivalent(layout, value);
		}
		const float = compilePulseSchema("float32").root;
		expect(Object.is(float.prepare(-0).value, 0)).toBe(true);
		expect(Object.is(float.prepare(-1e-100).value, -0)).toBe(true);
	});

	test("dense arrays, prototypes, aliases, cycles and unsupported runtime values", () => {
		const layout = compilePulseSchema(
			object({ items: array(object({ count: "uint" })) }),
		).root;
		const child = { count: 1 };
		const inheritedArray = new Array(1);
		Object.setPrototypeOf(
			inheritedArray,
			Object.assign(Object.create(Array.prototype), { 0: child }),
		);
		for (const value of [
			{ items: [child, child] },
			{ items: new Array(1) },
			{ items: inheritedArray },
			{ items: [Object.assign(Object.create(null), child)] },
			{ items: [Object.assign(Object.create({ inherited: true }), child)] },
			{ items: [{ count: 1 }], ignored: new Date(0) },
			{ items: [{ count: 1 }], ignored: new Set() },
			{ items: [{ count: 1 }], ignored: () => 1 },
			{ items: [{ count: 1 }], ignored: Symbol("unsupported") },
		])
			equivalent(layout, value);
		const cyclic: Record<string, unknown> = { items: [] };
		cyclic["ignored"] = cyclic;
		equivalent(layout, cyclic);
		const result = layout.prepare({ items: [child, child] }).value as {
			items: { count: number }[];
		};
		expect(result.items[0]).not.toBe(child);
		expect(result.items[0]).not.toBe(result.items[1]);
	});

	test("object fields use the same enumerable input properties as the portable clone", () => {
		for (const schema of [
			object({ count: "uint" }),
			object({ count: optional("uint") }),
		]) {
			const input = Object.defineProperty({}, "count", {
				value: 1,
				enumerable: false,
			});
			equivalent(compilePulseSchema(schema).root, input);
		}
		const schema = union({
			tagName: "type",
			tagType: "string",
			variants: { note: { count: "uint" } },
		});
		const hiddenTag = Object.defineProperty({ count: 1 }, "type", {
			value: "note",
			enumerable: false,
		});
		equivalent(compilePulseSchema(schema).root, hiddenTag);
	});

	test("explicit markers survive schema normalization, and dropped marker paths reject", () => {
		const layout = compilePulseSchema(
			object({
				body: "string",
				fixed: object({ value: "uint" }),
				pair: tuple("uint", "string"),
				rows: array(
					object({ body: "string", fixed: object({ value: "uint" }) }),
				),
			}),
			{ constantPaths: [["fixed"]], richTextPaths: [["body"]] },
		).root;
		const base = {
			body: richText("Hello 🌍"),
			fixed: struct({ value: 3 }),
			pair: constantTuple([4, "four"]),
			rows: [{ body: richText("row"), fixed: struct({ value: 5 }) }],
		};
		equivalent(layout, base);
		equivalent(layout, { ...base, ignored: richText("dropped") });
		equivalent(layout, { ...base, ignored: struct({ value: 1 }) });
		equivalent(layout, { ...base, ignored: { deep: constantTuple([1]) } });
		equivalent(layout, {
			...base,
			ignored: { valid: [1, 2, { key: "value" }] },
		});
		equivalent(layout, { ...base, ignored: { invalid: Infinity } });
		equivalent(layout, { ...base, ignored: { invalid: "\ud800" } });
		equivalent(layout, { ...base, body: { [RichTextSymbol]: true, text: 2 } });
		equivalent(layout, {
			...base,
			body: { [RichTextSymbol]: true, text: "\ud800" },
		});
		for (const key of ["__proto__", "constructor", "prototype", "\ud800"]) {
			const input = { ...base };
			Object.defineProperty(input, key, { value: 1, enumerable: true });
			equivalent(layout, input);
		}
	});

	test("optional, tagged and untagged unions use the same selected clone", () => {
		const tagged = union({
			tagName: "kind",
			tagType: "string",
			variants: {
				note: { body: "string", amount: optional("float32") },
				count: { count: "uint" },
			},
		});
		const numeric = union({
			tagName: "kind",
			tagType: "uint",
			variants: { 0: { body: "string" }, 1: { count: "uint" } },
		});
		const cases: readonly [Schema, readonly unknown[]][] = [
			[
				optional(array("string")),
				[undefined, [], ["ok"], [richText("ok")], null],
			],
			[
				tagged,
				[
					{ kind: "note", body: richText("ok") },
					{ kind: "note", body: "ok", amount: 1 / 3, extra: 1 },
					{ kind: "count", count: 2 },
					{ kind: "count", count: "2" },
					{ kind: "missing" },
				],
			],
			[
				numeric,
				[
					{ kind: 0, body: "ok" },
					{ kind: 1, count: 2 },
					{ kind: "0", body: "ok" },
				],
			],
			[
				union([object({ amount: "float32" }), object({ amount: "float64" })]),
				[{ amount: 1 / 3 }, { amount: -1e-100 }, { amount: 1e100 }],
			],
			[
				union(["string", object({ count: "uint" })]),
				[richText("ok"), { count: 3, extra: true }, false],
			],
		];
		for (const [schema, values] of cases)
			for (const value of values)
				equivalent(compilePulseSchema(schema).root, value);
	});

	test("map, tuple, literal and unknown layouts preserve the portable value grammar", () => {
		const cases: readonly [Schema, readonly unknown[]][] = [
			[
				map(optional("string")),
				[
					{},
					{ b: undefined, a: "ok" },
					Object.assign(Object.create(null), { a: "ok" }),
					{ a: richText("ok") },
					{ a: 2 },
				],
			],
			[
				tuple("uint", optional("string")),
				[
					[1, undefined],
					[1, "two"],
					[1],
					[1, "two", 3],
					new Array(2),
					constantTuple([1, "two"]),
				],
			],
			[
				literal({ fixed: [1, "a"] }),
				[
					{ fixed: [1, "a"] },
					{ fixed: [1, "a"], extra: true },
					{ fixed: [1, "b"] },
				],
			],
			[literal(0), [0, -0, 1]],
			[literal(-0), [0, -0]],
			[literal(3n), [3n, 4n]],
			[
				literal(new Uint8Array([1, 2])),
				[new Uint8Array([1, 2]), new Uint8Array([1, 3])],
			],
			[
				"unknown",
				[
					{
						bigint: 1n,
						bytes: new Uint8Array([1, 2]),
						body: richText("ok"),
						pair: constantTuple([1]),
					},
					undefined,
					new Date(0),
					new Set([1]),
				],
			],
		];
		for (const [schema, values] of cases)
			for (const value of values)
				equivalent(compilePulseSchema(schema).root, value);
		const bytes = new Uint8Array([1, 2]);
		const detached = compilePulseSchema("uint8Array").root.prepare(bytes)
			.value as Uint8Array;
		detached[0] = 9;
		expect(bytes[0]).toBe(1);
	});

	test("recursive layouts and initial depth obey the input depth before optional synthesis", () => {
		let recursive: Exclude<Schema, () => unknown>;
		recursive = object({ value: "uint", child: optional(() => recursive) });
		const layout = compilePulseSchema(recursive).root;
		const nested = (depth: number): Record<string, unknown> => {
			let value: Record<string, unknown> = { value: 0 };
			for (let i = 0; i < depth; i++) value = { value: i, child: value };
			return value;
		};
		for (const initialDepth of [0, 1, 15, 31, 32]) {
			for (const depth of [0, 1, 31, 32, 33])
				equivalent(layout, nested(depth), initialDepth);
		}
		const cycle = nested(1);
		cycle["child"] = cycle;
		equivalent(layout, cycle);
		for (const schema of [
			optional("string"),
			"string",
			"uint8Array",
		] as const) {
			const leaf = compilePulseSchema(schema).root;
			for (const initialDepth of [31, 32, 33]) {
				for (const input of [
					undefined,
					"ok",
					richText("ok"),
					new Uint8Array([1]),
				])
					equivalent(leaf, input, initialDepth);
			}
		}
	});

	test("normalization rejects a synthetic optional beyond depth 32 before mutation", () => {
		let schema: Exclude<Schema, () => unknown>;
		schema = object({ child: optional(() => schema) });
		const layout = compilePulseSchema(schema).root;
		let input: unknown = {};
		for (let i = 0; i < 32; i++) input = { child: input };
		// Previously the clone added undefined at depth 33 after the input check.
		expect(() => reference(layout, input)).not.toThrow();
		expect(() => layout.prepare(input)).toThrow("32 levels");
	});

	test("unknown subtrees include their enclosing schema depth", () => {
		let schema: Schema = "unknown";
		for (let i = 0; i < 10; i++) schema = object({ child: schema });
		const layout = compilePulseSchema(schema).root;
		for (const leafDepth of [21, 22, 23]) {
			let input: unknown = 1;
			for (let i = 0; i < leafDepth; i++) input = [input];
			for (let i = 0; i < 10; i++) input = { child: input };
			equivalent(layout, input);
		}
		const cycle: Record<string, unknown> = {};
		cycle["child"] = cycle;
		equivalent(
			compilePulseSchema(object({ child: object({ value: "uint" }) })).root,
			cycle,
		);
	});

	test("seeded mixed-value fuzz catches rejected extras and selected union branches", () => {
		let state = 0x51a7e;
		const random = () =>
			(state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000;
		const pick = <T>(values: readonly T[]): T =>
			values[Math.floor(random() * values.length)]!;
		const leaf = (): unknown =>
			pick([
				undefined,
				null,
				false,
				true,
				-0,
				-1e-100,
				1 / 3,
				2,
				4n,
				"",
				"🌍",
				"\ud800",
				NaN,
				Infinity,
				new Uint8Array([1, 2]),
				richText("marked"),
			]);
		const value = (depth: number): unknown => {
			if (!depth || random() < 0.6) return leaf();
			return random() < 0.5
				? [value(depth - 1), value(depth - 1)]
				: { a: value(depth - 1), b: value(depth - 1) };
		};
		const layouts = [
			compilePulseSchema("unknown").root,
			compilePulseSchema(
				object({ a: optional("float32"), b: optional("string") }),
			).root,
			compilePulseSchema(
				map(union(["string", "float32", "uint8Array", bigint()])),
			).root,
			compilePulseSchema(
				union([
					array("unknown"),
					object({ a: "unknown", b: optional("string") }),
				]),
			).root,
		];
		for (let i = 0; i < 160; i++) {
			const input = value(3);
			for (const layout of layouts) equivalent(layout, input);
		}
	});
});
