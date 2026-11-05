import { describe, expect, test } from "bun:test";
import {
	array,
	bigint,
	createCodec,
	literal,
	map,
	object,
	optional,
	set,
	tuple,
	union,
	type ArraySchema,
	type ObjectSchema,
} from "@gin-quin/codec";
import {
	compilePulseSchema,
	schemaFingerprint,
} from "../source/core/schema.js";
import { definePulse } from "../source/pulses/PulseDefinition.js";
import type { PulseProperties } from "../source/pulses/PulseProperties.js";

describe("compiled pulse schemas", () => {
	const schema = object({
		title: "string",
		count: "uint",
		settings: object({ color: "string", size: optional("uint") }),
		items: array(object({ label: "string", weight: "float64" })),
		metadata: map("string"),
	});
	const value = {
		title: "Notes",
		count: 4,
		settings: { color: "blue" },
		items: [{ label: "A", weight: 1.5 }],
		metadata: { a: "b" },
	};

	test("document and field bytes are the exact codec representation", () => {
		const compiled = compilePulseSchema(schema);
		expect(compiled.codec.encode(value)).toEqual(
			createCodec(schema).encode(value),
		);
		const count = compiled.fieldAt(["count"])!;
		expect(count.id).toBe(1);
		expect(compiled.encode(count.layout.id, 4)).toEqual(
			createCodec("uint").encode(4),
		);
		expect(
			compiled.decode(count.layout.id, createCodec("uint").encode(4)),
		).toBe(4);
		expect(() =>
			compiled.decode(count.layout.id, new Uint8Array([4, 0])),
		).toThrow("Trailing bytes");
	});

	test("field slots and layout ids are stable across independent compilation", () => {
		const left = compilePulseSchema(schema);
		const right = compilePulseSchema(structuredClone(schema));
		const shape = (compiled: typeof left) =>
			compiled.layouts.map((layout) => [
				layout.id,
				layout.kind,
				layout.fields.map((field) => [field.id, field.key, field.layout.id]),
			]);
		expect(shape(left)).toEqual(shape(right));
		expect(left.fieldAt(["items", 5, "weight"])!.id).toBe(1);
		expect(left.layoutAt(["metadata", "arbitrary-key"])!.kind).toBe("string");
		expect(left.layoutAt(["items", "wrong-index"])).toBeUndefined();
		expect(left.layoutAt(["absent"])).toBeUndefined();
	});

	test("annotations preserve schema identity and codec bytes", () => {
		const options = {
			constantPaths: [["settings"], ["items", "*", "weight"]],
			richTextPaths: [["title"]],
		};
		const compiled = compilePulseSchema(schema, options);
		expect(compiled.schema).toBe(schema);
		expect(compiled.fieldAt(["settings"])!.constant).toBe(true);
		expect(compiled.fieldAt(["settings", "color"])!.constant).toBe(true);
		expect(compiled.fieldAt(["items", 4, "weight"])!.constant).toBe(true);
		expect(compiled.fieldAt(["items", 4, "label"])!.constant).toBe(false);
		expect(compiled.fieldAt(["title"])!.richText).toBe(true);
		expect(compiled.codec.encode(value)).toEqual(
			createCodec(schema).encode(value),
		);
		expect(() =>
			compilePulseSchema(schema, { richTextPaths: [["count"]] }),
		).toThrow("string schema");
	});

	test("occurrence flags cover terminal array and map elements", () => {
		const collection = object({
			items: array(object({ id: "string" })),
			texts: map(optional("string")),
		});
		const compiled = compilePulseSchema(collection, {
			constantPaths: [["items", "*"]],
			richTextPaths: [["texts", "*"]],
		});
		expect(compiled.layoutAt(["items", 0])!.constant).toBe(true);
		expect(compiled.layoutAt(["items", 0, "id"])!.constant).toBe(true);
		expect(compiled.fieldAt(["items"])!.constant).toBe(false);
		expect(compiled.layoutAt(["texts", "any-key"])!.richText).toBe(true);
		expect(() =>
			compilePulseSchema(collection, { richTextPaths: [["items", "*"]] }),
		).toThrow("string schema");
	});

	test("schema clones detach arrays, objects, and typed leaves", () => {
		const richSchema = object({
			value: schema,
			bytes: "uint8Array",
			when: "date",
			tags: set("string"),
			pair: tuple("uint", object({ name: "string" })),
			fixed: literal({ version: 1 }),
			large: bigint(),
		});
		const original = {
			value,
			bytes: new Uint8Array([1, 2]),
			when: new Date(123),
			tags: new Set(["a"]),
			pair: [4, { name: "Ada" }] as [number, { name: string }],
			fixed: { version: 1 } as const,
			large: 123n,
		};
		const compiled = compilePulseSchema(richSchema);
		const copy = compiled.clone(original);
		expect(copy).toEqual({
			...original,
			value: { ...value, settings: { color: "blue", size: undefined } },
		});
		copy.value.items[0]!.label = "B";
		copy.bytes[0] = 9;
		copy.when.setTime(999);
		copy.tags.add("b");
		copy.pair[1].name = "Bob";
		expect(original.value.items[0]!.label).toBe("A");
		expect(original.bytes[0]).toBe(1);
		expect(original.when.getTime()).toBe(123);
		expect(original.tags.size).toBe(1);
		expect(original.pair[1].name).toBe("Ada");
		expect(copy.fixed).not.toBe(original.fixed);
	});

	test("compiled boundary checks reject coercions, holes, and cycles", () => {
		const compiled = compilePulseSchema(schema);
		expect(compiled.assert(value)).toBe(value);
		expect(() => compiled.assert({ ...value, count: -1 })).toThrow(
			"schema layout",
		);
		expect(() => compiled.assert({ ...value, count: "4" })).toThrow(
			"schema layout",
		);
		expect(() => compiled.assert({ ...value, title: 3 })).toThrow(
			"schema layout",
		);
		expect(() => compiled.assert({ ...value, items: new Array(2) })).toThrow(
			"schema layout",
		);
		const bool = compilePulseSchema("boolean");
		expect(() => bool.assert(1)).toThrow();
		const date = compilePulseSchema("date");
		expect(() => date.assert(new Date(Number.NaN))).toThrow();
		const float = compilePulseSchema("float32");
		expect(() => float.assert(1e100)).toThrow();
		expect(() => float.assert(Number.POSITIVE_INFINITY)).toThrow();
		expect(float.assert(1 / 3)).toBe(1 / 3);
		expect(() =>
			compilePulseSchema("float64").assert(Number.POSITIVE_INFINITY),
		).toThrow();
		expect(() => compilePulseSchema("string").assert("\ud800")).toThrow();
	});

	test("tagged and untagged unions preserve discriminants and optional shapes", () => {
		const tagged = union({
			tagName: "kind",
			tagType: "string",
			variants: {
				note: { title: "string" },
				count: { value: "uint" },
			},
		});
		const compiled = compilePulseSchema(tagged);
		const note = { kind: "note", title: "A" } as const;
		expect(compiled.assert(note)).toBe(note);
		expect(compiled.clone(note)).toEqual(note);
		expect(compiled.fieldAt(["title"], note)!.layout.kind).toBe("string");
		expect(compiled.fieldAt(["kind"], note)!.constant).toBe(true);
		expect(compiled.fieldAt(["title"])).toBeUndefined();
		expect(() => compiled.assert({ kind: "count", value: "1" })).toThrow();
		const untagged = compilePulseSchema(
			union(["string", object({ count: "uint" })]),
		);
		expect(untagged.assert("x")).toBe("x");
		expect(untagged.assert({ count: 2 })).toEqual({ count: 2 });
		expect(() => untagged.assert(false)).toThrow();
	});

	test("recursive lazy schemas compile once per active schema and copy finite trees", () => {
		type TreeSchema = ObjectSchema<{
			label: "string";
			children: ArraySchema<() => TreeSchema>;
		}>;
		const tree: TreeSchema = object({
			label: "string",
			children: array(() => tree),
		});
		const compiled = compilePulseSchema(tree);
		const input = {
			label: "root",
			children: [{ label: "child", children: [] }],
		};
		expect(compiled.layouts.length).toBe(3);
		expect(compiled.assert(input)).toBe(input);
		expect(compiled.clone(input)).toEqual(input);
		expect(compiled.fieldAt(["children", 0, "label"])!.id).toBe(0);
		const cycle: { label: string; children: unknown[] } = {
			label: "cycle",
			children: [],
		};
		cycle.children.push(cycle);
		expect(() => compiled.assert(cycle)).toThrow();
	});

	test("generated property access does not interpret schema field names as code", () => {
		const key = 'title"];throw new Error("injected");//';
		const compiled = compilePulseSchema(object({ [key]: "string" }));
		const field = compiled.root.fields[0]!;
		const data = { [key]: "A" };
		expect(field.get(data)).toBe("A");
		field.set(data, "B");
		expect(compiled.clone(data)).toEqual({ [key]: "B" });
	});

	test("invalid compiled property names are rejected before a definition can be used", () => {
		for (const key of ["__proto__", "constructor", "prototype", "\ud800"]) {
			expect(() =>
				compilePulseSchema(object({ [key]: optional("string") })),
			).toThrow("Unsupported pulse schema property");
			expect(() =>
				compilePulseSchema(
					object({ body: optional(object({ [key]: optional("string") })) }),
				),
			).toThrow("Unsupported pulse schema property");
			expect(() =>
				definePulse(
					"InvalidProperty",
					object({ body: optional(object({ [key]: optional("string") })) }),
				).materialize(),
			).toThrow("Unsupported pulse schema property");
			expect(() =>
				compilePulseSchema(
					union({
						tagName: key,
						tagType: "string",
						variants: { valid: { value: "string" } },
					}),
				),
			).toThrow("Unsupported pulse schema property");
			expect(() =>
				compilePulseSchema(
					union({
						tagName: "kind",
						tagType: "string",
						variants: { valid: { [key]: optional("string") } },
					}),
				),
			).toThrow("Unsupported pulse schema property");
		}
	});

	test("definitions retain original schemas and one compiled layout", () => {
		const definition = definePulse("Compiled", schema, {
			constantPaths: [["settings"]],
		}).materialize();
		expect(definition.schema).toBe(schema);
		expect(definition.compiledSchema!.fieldAt(["settings"])!.constant).toBe(
			true,
		);
		const viaBuilder = definePulse("Compiled").schema(schema).materialize();
		expect(viaBuilder.schema).toBe(schema);
	});

	test("versioned definitions preserve each schema and its annotations", () => {
		const v1 = object({ name: "string" });
		const v2 = object({ name: "string", email: "string" });
		const v3 = object({ name: "string", email: "string", active: "boolean" });
		type V2 = PulseProperties<"Versioned"> & { name: string; email: string };
		type V3 = V2 & { active: boolean };
		const builder = definePulse("Versioned", v1, { constantPaths: [["name"]] });
		const first = builder.materialize();
		const latest = builder
			.migrate<V2>(() => ({ email: "ada@example.com" }))
			.schema(v2, { richTextPaths: [["name"]] })
			.migrate<V3>((before) => ({
				active: true,
				name: before.name.toString(),
			}))
			.schema(v3)
			.materialize();
		expect(latest.schemas).toHaveLength(3);
		expect(latest.schemas![0]).toBe(first.compiledSchema);
		expect(latest.schemas!.map((entry) => entry?.schema)).toEqual([v1, v2, v3]);
		expect(latest.schemas![0]!.fieldAt(["name"])!.constant).toBe(true);
		expect(latest.schemas![1]!.fieldAt(["name"])!.richText).toBe(true);
		expect(latest.schemas![2]).toBe(latest.compiledSchema);
		expect(first.schemas).toHaveLength(1);
	});

	test("registry keeps legacy gaps and reuses unchanged compiled schemas", () => {
		type Legacy = PulseProperties<"LegacyTyped"> & { name: string };
		type Current = Legacy & { email: string };
		const migrated = definePulse<Legacy>("LegacyTyped")
			.migrate<Current>(() => ({ email: "a@b.test" }))
			.schema(object({ name: "string", email: "string" }))
			.materialize();
		expect(migrated.schemas).toHaveLength(2);
		expect(migrated.schemas![0]).toBeUndefined();
		expect(migrated.schemas![1]).toBe(migrated.compiledSchema);
		const sameShape = definePulse("SameShape", object({ name: "string" }))
			.migrate<PulseProperties<"SameShape"> & { name: string }>(() => ({
				name: "New",
			}))
			.materialize();
		expect(sameShape.schemas![0]).toBe(sameShape.schemas![1]);
		expect(
			definePulse<Legacy>("LegacyTyped").materialize().schemas,
		).toBeUndefined();
	});

	test("fingerprints are compact, stable, and sensitive to binary layout and annotations", () => {
		const same = () => object({ first: "string", second: "uint" });
		const original = schemaFingerprint(compilePulseSchema(same()));
		expect(original).toHaveLength(32);
		expect(original).toMatch(/^[0-9a-f]+$/);
		expect(schemaFingerprint(compilePulseSchema(same()))).toBe(original);
		expect(
			schemaFingerprint(
				compilePulseSchema(object({ second: "uint", first: "string" })),
			),
		).not.toBe(original);
		expect(
			schemaFingerprint(
				compilePulseSchema(object({ first: "string", second: "int" })),
			),
		).not.toBe(original);
		expect(
			schemaFingerprint(
				compilePulseSchema(same(), { constantPaths: [["first"]] }),
			),
		).not.toBe(original);
		expect(
			schemaFingerprint(
				compilePulseSchema(same(), { richTextPaths: [["first"]] }),
			),
		).not.toBe(original);
		const annotated = compilePulseSchema(same(), {
			constantPaths: [["first"], ["second"], ["first"]],
		});
		expect(schemaFingerprint(annotated)).toBe(
			schemaFingerprint(
				compilePulseSchema(same(), { constantPaths: [["second"], ["first"]] }),
			),
		);
		expect(schemaFingerprint(annotated)).toBe(schemaFingerprint(annotated));
		expect(schemaFingerprint(compilePulseSchema(literal(1)))).not.toBe(
			schemaFingerprint(compilePulseSchema(literal(2))),
		);
		expect(schemaFingerprint(compilePulseSchema(bigint(8)))).not.toBe(
			schemaFingerprint(compilePulseSchema(bigint(9))),
		);
	});

	test("recursive lazy schema fingerprints are independent of closure identity", () => {
		type TreeSchema = ObjectSchema<{
			label: "string";
			children: ArraySchema<() => TreeSchema>;
		}>;
		const make = () => {
			const tree: TreeSchema = object({
				label: "string",
				children: array(() => tree),
			});
			return tree;
		};
		const left = make();
		const right = make();
		expect(schemaFingerprint(compilePulseSchema(left))).toBe(
			schemaFingerprint(compilePulseSchema(right)),
		);
		expect(schemaFingerprint(compilePulseSchema(() => left))).toBe(
			schemaFingerprint(compilePulseSchema(left)),
		);
	});

	test("layout clones normalize float32 and object ordering exactly like codec", () => {
		const numeric = object({
			first: "float32",
			rows: array(object({ amount: "float32", name: "string" })),
			values: map("float32"),
			choice: union([object({ amount: "float32" }), "string"]),
		});
		const input = {
			first: 1 / 3,
			rows: [{ name: "A", amount: 2 / 3, extra: true }],
			values: { a: 4 / 3 },
			choice: { amount: 5 / 3, extra: true },
		};
		const compiled = compilePulseSchema(numeric);
		const expected = compiled.codec.decode(compiled.codec.encode(input));
		expect(compiled.clone(input)).toEqual(expected);
		expect(compiled.root.clone(input)).toEqual(expected);
		expect(compiled.fieldAt(["first"])!.layout.clone(1 / 3)).toBe(
			Math.fround(1 / 3),
		);
		expect(Object.keys(compiled.clone(input).rows[0]!)).toEqual([
			"amount",
			"name",
		]);
		expect(Object.keys(compiled.clone(input).choice)).toEqual(["amount"]);
	});
});
