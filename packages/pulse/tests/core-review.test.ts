import { expect, test } from "bun:test";
import { object, tuple as schemaTuple } from "@gin-quin/codec";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	snapshotPulse,
	type PulseProperties,
} from "../source/index.js";
import { patchToRow } from "../source/connection/PulsePatch.js";
import { CorePatch } from "../source/core/operations.js";
import { richText, type RichText } from "../source/core/richText.js";
import { prepareValue } from "../source/core/values.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";

const options = (sessionId: number) => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId,
});

test("core review: schema field order gives nested containers identical IDs", () => {
	const Definition = definePulse(
		"SchemaOrder",
		object({
			left: object({ value: "uint" }),
			right: object({ value: "uint" }),
		}),
	).materialize();
	const a = createPulse(
		Definition,
		{ right: { value: 20 }, left: { value: 10 } },
		options(65536),
	);
	const b = createRuntime(Definition, a.id, options(65537));
	try {
		getPulseMeta(b).applyRows(getPulseMeta(a).log.missing([]));
		a.left.value = 11;
		getPulseMeta(b).applyRows(
			getPulseMeta(a).log.missing(getPulseMeta(b).log.vector),
		);
		expect(snapshotPulse(b)).toEqual(snapshotPulse(a));
	} finally {
		destroyPulse(a);
		destroyPulse(b);
	}
});

test("core review: schema extras are rejected or removed before IDs are allocated", () => {
	const Definition = definePulse(
		"SchemaExtras",
		object({ nested: object({ value: "uint" }) }),
	).materialize();
	const config = options(65536);
	let a: ReturnType<typeof createPulse<typeof Definition>>;
	try {
		a = createPulse(
			Definition,
			{ extra: { value: 99 }, nested: { value: 1 } } as any,
			config,
		);
	} catch (error) {
		expect(error).toBeInstanceOf(TypeError);
		expect(config.scope.pulses.size).toBe(0);
		return;
	}
	const b = createRuntime(Definition, a.id, options(65537));
	try {
		expect(Object.hasOwn(snapshotPulse(a), "extra")).toBe(false);
		getPulseMeta(b).applyRows(getPulseMeta(a).log.missing([]));
		a.nested.value = 2;
		getPulseMeta(b).applyRows(
			getPulseMeta(a).log.missing(getPulseMeta(b).log.vector),
		);
		expect(snapshotPulse(b)).toEqual(snapshotPulse(a));
	} finally {
		destroyPulse(a);
		destroyPulse(b);
	}
});

test("core review: float32 uses its wire value on the originating replica", () => {
	const Definition = definePulse(
		"SchemaFloat",
		object({ value: "float32" }),
	).materialize();
	const a = createPulse(Definition, { value: 1 / 3 }, options(65536));
	const b = createRuntime(Definition, a.id, options(65537));
	try {
		expect(a.value).toBe(Math.fround(1 / 3));
		getPulseMeta(b).applyRows(getPulseMeta(a).log.missing([]));
		a.value = Math.PI;
		expect(a.value).toBe(Math.fround(Math.PI));
		getPulseMeta(b).applyRows(
			getPulseMeta(a).log.missing(getPulseMeta(b).log.vector),
		);
		expect(snapshotPulse(b)).toEqual(snapshotPulse(a));
	} finally {
		destroyPulse(a);
		destroyPulse(b);
	}
});

test("core review: tuple edits preserve element schemas and tuple cardinality", () => {
	const Definition = definePulse(
		"SchemaTuple",
		object({ pair: schemaTuple("uint", "string") }),
	).materialize();
	const pulse = createPulse(Definition, { pair: [1, "one"] }, options(65536));
	try {
		const before = snapshotPulse(pulse);
		const vector = getPulseMeta(pulse).log.vector;
		for (const edit of [
			() => {
				(pulse.pair as any)[0] = "wrong";
			},
			() => {
				(pulse.pair as any).push("extra");
			},
			() => {
				(pulse.pair as any).splice(0, 1);
			},
		]) {
			expect(edit).toThrow();
			expect(snapshotPulse(pulse)).toEqual(before);
			expect(getPulseMeta(pulse).log.vector).toEqual(vector);
		}
	} finally {
		destroyPulse(pulse);
	}
});

test("core review: remote text markers cannot change a typed scalar into a sequence", () => {
	const Definition = definePulse(
		"SchemaMarker",
		object({ count: "uint" }),
	).materialize();
	const pulse = createPulse(Definition, { count: 1 }, options(65536));
	try {
		const meta = getPulseMeta(pulse);
		const before = snapshotPulse(pulse);
		const vector = meta.log.vector;
		const value = prepareValue(55);
		value.texts = [[]];
		const row = patchToRow(
			pulse.id,
			new CorePatch(65537, 1, 2, meta.model.schemaId, [
				{
					kind: 1,
					target: meta.model.root!.id,
					field: "count",
					value,
				},
			]),
			vector,
		);
		expect(() => meta.applyRows([row])).toThrow();
		expect(snapshotPulse(pulse)).toEqual(before);
		expect(meta.log.vector).toEqual(vector);
	} finally {
		destroyPulse(pulse);
	}
});

test("core review: rich text deltas retain distinct binary and object attributes", () => {
	type TextDocument = PulseProperties<"RichAttributeTypes"> & {
		body: RichText;
	};
	const Definition =
		definePulse<TextDocument>("RichAttributeTypes").materialize();
	const pulse = createPulse(
		Definition,
		{ body: richText("ab") },
		options(65536),
	);
	try {
		pulse.body.format(0, 1, { meta: new Uint8Array([1]) });
		pulse.body.format(1, 1, { meta: { 0: 1 } });
		expect(pulse.body.toDelta()).toEqual([
			{ insert: "a", attributes: { meta: new Uint8Array([1]) } },
			{ insert: "b", attributes: { meta: { 0: 1 } } },
		]);
	} finally {
		destroyPulse(pulse);
	}
});
