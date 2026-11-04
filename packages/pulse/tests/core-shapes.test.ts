import { describe, expect, test } from "bun:test";
import {
	array,
	literal,
	map,
	object,
	optional,
	tuple,
	union,
	type ArraySchema,
	type ObjectSchema,
	type OptionalSchema,
} from "@gin-quin/codec";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	richText,
	snapshotPulse,
	arrayOperations,
	type CreatePulseInput,
	type DataFromDefinition,
	type ModelFromDefinition,
	type Pulse,
} from "../source/index.js";
import type { AnyPulseDefinition } from "../source/pulses/PulseDefinition.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import {
	encodeMessage,
	decodeMessage,
} from "../source/connection/PulseMessage.js";
import type { PulsePatchRow } from "../source/connection/PulsePatch.js";

const options = (sessionId: number) => ({
	...defaultPulseOptions,
	sessionId,
	scope: createPulseScope(),
});
function wire(rows: PulsePatchRow[]): PulsePatchRow[] {
	if (!rows.length) return [];
	const result = decodeMessage(
		encodeMessage({
			kind: 4,
			docId: rows[0]!.docId,
			requestId: 0,
			vv: [],
			rows,
		}),
	);
	if (result.kind !== 4) throw new Error("Expected a patch message");
	return result.rows;
}

/** Initial replay, edits in both directions, then replay from mixed-actor history. */
function exercise<D extends AnyPulseDefinition>(
	definition: D,
	input: CreatePulseInput<DataFromDefinition<D>>,
	edit: (pulse: Pulse<ModelFromDefinition<D>>, phase: number) => void,
): void {
	const source = createPulse(definition, input, options(65536));
	const peer = createRuntime(definition, source.id, options(65537)) as Pulse<
		ModelFromDefinition<D>
	>;
	const replay = createRuntime(definition, source.id, options(65538)) as Pulse<
		ModelFromDefinition<D>
	>;
	try {
		const sourceMeta = getPulseMeta(source),
			peerMeta = getPulseMeta(peer),
			replayMeta = getPulseMeta(replay);
		peerMeta.applyRows(wire(sourceMeta.log.missing([])));
		expect(source.id).toBeDefined();
		expect(source.version).toBe(1);
		expect(snapshotPulse(peer)).toEqual(snapshotPulse(source));
		expect(peerMeta.log.vector).toEqual(sourceMeta.log.vector);
		edit(source, 1);
		const forward = sourceMeta.log.missing(peerMeta.log.vector);
		expect(forward.length).toBeGreaterThan(0);
		peerMeta.applyRows(wire(forward));
		expect(snapshotPulse(peer)).toEqual(snapshotPulse(source));
		edit(peer, 2);
		const reverse = peerMeta.log.missing(sourceMeta.log.vector);
		expect(reverse.length).toBeGreaterThan(0);
		sourceMeta.applyRows(wire(reverse));
		expect(snapshotPulse(source)).toEqual(snapshotPulse(peer));
		const complete = wire(sourceMeta.log.missing([]));
		replayMeta.applyRows(complete);
		expect(snapshotPulse(replay)).toEqual(snapshotPulse(source));
		expect(replayMeta.log.vector).toEqual(sourceMeta.log.vector);
		replayMeta.applyRows([...complete].reverse());
		expect(snapshotPulse(replay)).toEqual(snapshotPulse(source));
		expect(replayMeta.log.pendingCount).toBe(0);
	} finally {
		for (const pulse of [source, peer, replay]) destroyPulse(pulse);
	}
}

describe("typed shape integration matrix", () => {
	test("object fields and nested replacements canonicalize permuted property order", () => {
		const schema = object({
			title: "string",
			nested: object({ count: "uint", label: "string" }),
			rows: array(object({ name: "string", enabled: "boolean" })),
		});
		const definition = definePulse("ShapeObject", schema).materialize();
		exercise(
			definition,
			{
				id: "shape-object",
				rows: [{ enabled: true, name: "First" }],
				nested: { label: "Initial", count: 1 },
				title: "Title",
			},
			(pulse, phase) => {
				pulse.title = `Title ${phase}`;
				pulse.nested = { label: `Replacement ${phase}`, count: phase };
				pulse.nested.count = phase + 10;
				pulse.nested.label = `Label ${phase}`;
				pulse.rows[0]!.name = `Row ${phase}`;
				pulse.rows[0]!.enabled = phase % 2 === 0;
				pulse.rows.push({ enabled: false, name: `New ${phase}` });
			},
		);
	});

	for (const branch of ["note", "count"] as const)
		test(`root tagged union branch ${branch} preserves metadata and editable leaves`, () => {
			const schema = union({
				tagName: "type",
				tagType: "string",
				variants: {
					note: { title: "string", nested: object({ value: "uint" }) },
					count: { value: "uint", label: "string" },
				},
			});
			const definition = definePulse("ShapeRootUnion", schema).materialize();
			const input =
				branch === "note"
					? {
							id: "shape-root-note",
							nested: { value: 1 },
							title: "Note",
							type: "note" as const,
						}
					: {
							id: "shape-root-count",
							label: "Count",
							value: 1,
							type: "count" as const,
						};
			exercise(definition, input, (pulse, phase) => {
				if (pulse.type === "note") {
					pulse.title = `Note ${phase}`;
					pulse.nested.value = phase + 20;
				} else {
					pulse.value = phase + 30;
					pulse.label = `Count ${phase}`;
				}
			});
		});

	test("lazy root objects retain metadata through full wire history and nested edits", () => {
		const concrete = object({
			nested: object({ value: "uint", label: "string" }),
			title: "string",
		});
		const definition = definePulse(
			"ShapeLazyRoot",
			() => concrete,
		).materialize();
		exercise(
			definition,
			{
				id: "shape-lazy-root",
				title: "Lazy",
				nested: { label: "Nested", value: 1 },
			},
			(pulse, phase) => {
				pulse.title = `Lazy ${phase}`;
				pulse.nested = { label: `Nested ${phase}`, value: phase };
				pulse.nested.value = phase + 10;
			},
		);
	});

	test("optional nested objects can be assigned, removed and rebuilt before subsequent child edits", () => {
		const schema = object({
			name: "string",
			detail: optional(
				object({
					enabled: "boolean",
					nested: optional(object({ label: "string", value: "int" })),
				}),
			),
		});
		const definition = definePulse("ShapeOptional", schema).materialize();
		exercise(
			definition,
			{ id: "shape-optional", name: "Optional" },
			(pulse, phase) => {
				pulse.name = `Optional ${phase}`;
				if (phase === 2) delete pulse.detail;
				pulse.detail = {
					nested: { value: -phase, label: `Nested ${phase}` },
					enabled: false,
				};
				pulse.detail.enabled = true;
				delete pulse.detail.nested;
				pulse.detail.nested = { value: -phase * 2, label: `Rebuilt ${phase}` };
				pulse.detail.nested.label = `Final ${phase}`;
			},
		);
	});

	test("maps of objects support key insertion, replacement, deletion and nested array edits", () => {
		const schema = object({
			values: map(
				object({
					count: "float32",
					rows: array(object({ name: "string", enabled: "boolean" })),
					label: optional("string"),
				}),
			),
		});
		const definition = definePulse("ShapeMapObjects", schema).materialize();
		exercise(
			definition,
			{
				id: "shape-map-objects",
				values: {
					second: { rows: [{ enabled: false, name: "B" }], count: 2 / 3 },
					first: { rows: [{ enabled: true, name: "A" }], count: 1 / 3 },
				},
			},
			(pulse, phase) => {
				for (const key of Object.keys(pulse.values)) {
					pulse.values[key]!.count = phase / 3;
					if (pulse.values[key]!.rows.length) {
						pulse.values[key]!.rows[0]!.name = `${key} ${phase}`;
						pulse.values[key]!.rows[0]!.enabled = true;
					}
					pulse.values[key]!.label = `Label ${phase}`;
				}
				pulse.values["new"] = {
					rows: [{ enabled: false, name: "New" }],
					count: phase / 7,
				};
				pulse.values["new"]!.rows[0]!.name = `New ${phase}`;
				delete pulse.values["second"];
			},
		);
	});

	test("arrays of tagged unions preserve branch layouts across replacement and insertion", () => {
		const row = union("string", {
			note: { title: "string", meta: object({ rank: "uint" }) },
			count: { value: "float64" },
		});
		const definition = definePulse(
			"ShapeArrayUnion",
			object({ rows: array(row) }),
		).materialize();
		exercise(
			definition,
			{
				id: "shape-array-union",
				rows: [
					{ meta: { rank: 1 }, title: "First", type: "note" },
					{ value: 2, type: "count" },
				],
			},
			(pulse, phase) => {
				for (const item of pulse.rows) {
					if (item.type === "note") {
						item.title = `Note ${phase}`;
						item.meta.rank = phase + 10;
					} else item.value = phase + 0.5;
				}
				pulse.rows[1] = {
					type: "note",
					title: `Replaced ${phase}`,
					meta: { rank: phase },
				};
				const second = pulse.rows[1]!;
				if (second.type === "note") second.meta.rank = phase + 30;
				pulse.rows.splice(0, 0, { type: "count", value: phase + 40 });
			},
		);
	});

	test("untagged object/string/null unions can replace branches and then address new child IDs", () => {
		const schema = object({
			choice: union([
				object({ value: "uint", nested: object({ label: "string" }) }),
				"string",
				"null",
			]),
		});
		const definition = definePulse("ShapeUntaggedUnion", schema).materialize();
		exercise(
			definition,
			{
				id: "shape-untagged",
				choice: { nested: { label: "Initial" }, value: 1 },
			},
			(pulse, phase) => {
				pulse.choice = phase === 1 ? "Intermediate" : null;
				pulse.choice = { nested: { label: `Rebuilt ${phase}` }, value: phase };
				pulse.choice.value = phase + 10;
				pulse.choice.nested.label = `Final ${phase}`;
			},
		);
	});

	test("codec tuples retain fixed cardinality and each position's runtime schema", () => {
		const schema = object({
			pair: tuple(
				"string",
				"uint",
				object({ score: "float32", label: "string" }),
			),
		});
		const definition = definePulse("ShapeTuple", schema).materialize();
		exercise(
			definition,
			{
				id: "shape-tuple",
				pair: ["Initial", 1, { label: "Item", score: 1 / 3 }],
			},
			(pulse, phase) => {
				pulse.pair[0] = `Tuple ${phase}`;
				pulse.pair[1] = phase;
				const cell = pulse.pair[2]!;
				if (typeof cell !== "object")
					throw new Error("Expected tuple object position");
				cell.score = phase / 7;
				cell.label = `Label ${phase}`;
				arrayOperations(pulse.pair).replaceAll([
					`Replaced ${phase}`,
					phase + 10,
					{ label: `Rebuilt ${phase}`, score: phase / 7 },
				]);
				const vector = getPulseMeta(pulse).log.vector;
				expect(() => pulse.pair.push("invalid cardinality")).toThrow(
					"cardinality",
				);
				expect(() => Reflect.set(pulse.pair, "1", "invalid integer")).toThrow(
					"schema layout",
				);
				expect(getPulseMeta(pulse).log.vector).toEqual(vector);
			},
		);
	});

	test("binary leaves and finite primitives round-trip after every editable scalar changes", () => {
		const schema = object({
			text: "string",
			enabled: "boolean",
			nothing: "null",
			missing: "undefined",
			optional: optional("uint"),
			signed: "int",
			unsigned: "uint",
			small: "float32",
			double: "float64",
			bytes: "uint8Array",
		});
		const definition = definePulse("ShapePrimitives", schema).materialize();
		exercise(
			definition,
			{
				id: "shape-primitives",
				bytes: new Uint8Array([9, 1, 2, 8]).subarray(1, 3),
				double: 1 / 7,
				small: 1 / 3,
				unsigned: 1,
				signed: -1,
				missing: undefined,
				nothing: null,
				enabled: true,
				text: "Initial",
			},
			(pulse, phase) => {
				pulse.text = `Unicode 😀 ${phase}`;
				pulse.enabled = phase % 2 === 0;
				pulse.nothing = null;
				pulse.missing = undefined;
				pulse.optional = phase;
				pulse.signed = -phase * 100;
				pulse.unsigned = phase * 100;
				pulse.small = phase / 3;
				pulse.double = phase / 7;
				pulse.bytes = new Uint8Array([phase, phase + 1]);
				const bytes = pulse.bytes;
				bytes[0] = 99;
				expect(pulse.bytes[0]).toBe(phase);
			},
		);
	});

	test("recursive schemas preserve a path-specific constant without freezing deeper occurrences", () => {
		type TreeSchema = ObjectSchema<{
			value: "uint";
			label: "string";
			child: OptionalSchema<() => TreeSchema>;
			children: ArraySchema<() => TreeSchema>;
		}>;
		const tree: TreeSchema = object({
			value: "uint",
			label: "string",
			child: optional(() => tree),
			children: array(() => tree),
		});
		const definition = definePulse("ShapeRecursive", object({ node: tree }), {
			constantPaths: [["node", "child", "value"]],
		}).materialize();
		exercise(
			definition,
			{
				id: "shape-recursive",
				node: {
					children: [{ children: [], label: "Array child", value: 3 }],
					child: { children: [], label: "Child", value: 2 },
					label: "Root",
					value: 1,
				},
			},
			(pulse, phase) => {
				pulse.node.value = phase + 10;
				pulse.node.label = `Root ${phase}`;
				pulse.node.child!.label = `Child ${phase}`;
				expect(() => Reflect.set(pulse.node.child!, "value", 99)).toThrow(
					"constant",
				);
				pulse.node.child!.child = {
					children: [],
					label: "Grandchild",
					value: phase,
				};
				pulse.node.child!.child!.value = phase + 20;
				pulse.node.children[0]!.value = phase + 30;
				pulse.node.children[0]!.label = `Array child ${phase}`;
				pulse.node.children.push({
					children: [],
					label: `New child ${phase}`,
					value: phase + 40,
				});
			},
		);
	});

	test("terminal rich text annotations work in arrays and maps with optional absent entries", () => {
		const definition = definePulse(
			"ShapeTerminalText",
			object({
				items: array(optional("string")),
				byKey: map(optional("string")),
			}),
			{
				richTextPaths: [
					["items", "*"],
					["byKey", "*"],
				],
			},
		).materialize();
		exercise(
			definition,
			{
				id: "shape-terminal-text",
				byKey: { present: "Map", absent: undefined },
				items: [undefined, "Array"],
			},
			(pulse, phase) => {
				expect(pulse.items[0]).toBeUndefined();
				expect(pulse.byKey["absent"]).toBeUndefined();
				pulse.items[1]!.insert(pulse.items[1]!.length, String(phase));
				pulse.items[1]!.format(0, 1, { phase });
				pulse.items.push(richText(`New ${phase}`));
				pulse.byKey["present"]!.insert(
					pulse.byKey["present"]!.length,
					String(phase),
				);
				pulse.byKey["present"]!.format(0, 1, { bold: phase % 2 === 0 });
				pulse.byKey["new"] = richText(`New map ${phase}`);
				pulse.byKey["new"]!.insert(pulse.byKey["new"]!.length, "!");
			},
		);
	});

	test("literal object values remain constant beside editable fields", () => {
		const value = { key: "fixed", nested: { label: "Constant" } };
		const definition = definePulse(
			"ShapeLiteralField",
			object({ fixed: literal(value), count: "uint" }),
		).materialize();
		exercise(
			definition,
			{
				id: "shape-literal-field",
				count: 1,
				fixed: { nested: { label: "Constant" }, key: "fixed" },
			},
			(pulse, phase) => {
				pulse.count = phase + 10;
				expect(pulse.fixed.nested.label).toBe("Constant");
				expect(() =>
					Reflect.set(pulse.fixed.nested, "label", "changed"),
				).toThrow();
				expect(() =>
					Reflect.set(pulse, "fixed", {
						key: "other",
						nested: { label: "Other" },
					}),
				).toThrow();
			},
		);
	});

	test("root constant annotations preserve managed metadata", () => {
		const definition = definePulse(
			"ShapeConstantRoot",
			object({ name: "string", nested: object({ value: "uint" }) }),
			{ constantPaths: [[]] },
		).materialize();
		const pulse = createPulse(
			definition,
			{ id: "shape-constant-root", nested: { value: 1 }, name: "Constant" },
			options(65536),
		);
		try {
			expect(pulse.id).toBe("shape-constant-root");
			expect(pulse.kind).toBe("ShapeConstantRoot");
			expect(pulse.version).toBe(1);
			expect(pulse.name).toBe("Constant");
			expect(() => Reflect.set(pulse, "name", "changed")).toThrow();
			const peer = createRuntime(definition, pulse.id, options(65537));
			try {
				getPulseMeta(peer).applyRows(getPulseMeta(pulse).log.missing([]));
				expect(snapshotPulse(peer)).toEqual(snapshotPulse(pulse));
				expect(() => Reflect.set(peer, "name", "changed")).toThrow();
			} finally {
				destroyPulse(peer);
			}
		} finally {
			destroyPulse(pulse);
		}
	});

	test("literal object root schemas preserve managed metadata", () => {
		const definition = definePulse(
			"ShapeLiteralRoot",
			literal({ name: "Constant", value: 1 }),
		).materialize();
		const pulse = createPulse(
			definition,
			{ id: "shape-literal-root", value: 1, name: "Constant" },
			options(65536),
		);
		try {
			expect(pulse.id).toBe("shape-literal-root");
			expect(pulse.version).toBe(1);
			expect(pulse.name).toBe("Constant");
			expect(() => Reflect.set(pulse, "name", "changed")).toThrow();
			const peer = createRuntime(definition, pulse.id, options(65537));
			try {
				getPulseMeta(peer).applyRows(getPulseMeta(pulse).log.missing([]));
				expect(snapshotPulse(peer)).toEqual(snapshotPulse(pulse));
				expect(() => Reflect.set(peer, "name", "changed")).toThrow();
			} finally {
				destroyPulse(peer);
			}
		} finally {
			destroyPulse(pulse);
		}
	});
});
