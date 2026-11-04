import { expect, test } from "bun:test";
import {
	object,
	array,
	union,
	optional,
	type ObjectSchema,
	type OptionalSchema,
} from "@gin-quin/codec";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	snapshotPulse,
} from "../source/index.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import { patchToRow } from "../source/connection/PulsePatch.js";
import { CorePatch } from "../source/core/operations.js";
import { prepareValue } from "../source/core/values.js";

const options = (sessionId: number) => ({
	...defaultPulseOptions,
	scope: createPulseScope(),
	sessionId,
});
const history = (pulse: any) => getPulseMeta(pulse).log.missing([]);
const apply = (pulse: any, rows: any[]) => getPulseMeta(pulse).applyRows(rows);

test("reviewer v2: root tagged union preserves managed metadata", () => {
	const def = definePulse(
		"RootUnion",
		union({
			tagName: "type",
			tagType: "string",
			variants: { a: { name: "string" }, b: { count: "uint" } },
		}),
	).materialize();
	const a = createPulse(
		def,
		{ id: "root-union-review", type: "a", name: "Ada" },
		options(65536),
	);
	try {
		expect(a.id).toBe("root-union-review");
		expect(a.version).toBe(1);
	} finally {
		destroyPulse(a);
	}
});

test("reviewer v2: nested constant upgrades converge across late v1 edits", () => {
	const schema = object({
		profile: object({ origin: object({ source: "string" }) }),
	});
	const builder = definePulse("NestedConstantMigrationReview", schema);
	const old = builder.materialize();
	const latest = builder
		.migrate<any>("freeze", () => ({}))
		.schema(schema, { constantPaths: [["profile", "origin"]] })
		.materialize();
	const source = createPulse(
		old,
		{
			id: "nested-constant-review",
			profile: { origin: { source: "initial" } },
		},
		options(65536),
	);
	const author = createRuntime(latest, source.id, options(65537));
	const before = createRuntime(latest, source.id, options(65538));
	const after = createRuntime(latest, source.id, options(65539));
	try {
		const base = history(source);
		const baseVector = getPulseMeta(source).log.vector;
		apply(author, base);
		const capture = getPulseMeta(author).log.missing(baseVector);
		source.profile.origin.source = "late edit";
		const late = getPulseMeta(source).log.missing(baseVector);
		apply(before, [...base, ...late, ...capture]);
		apply(after, [...base, ...capture]);
		apply(after, late);
		expect(snapshotPulse(before)).toEqual(snapshotPulse(after));
	} finally {
		for (const p of [source, author, before, after]) destroyPulse(p);
	}
});

test("reviewer v2: schema rich text write without markers remains rich text", () => {
	const def = definePulse("RichWriteReview", object({ body: "string" }), {
		richTextPaths: [["body"]],
	}).materialize();
	const p = createPulse(
		def,
		{ id: "rich-write-review", body: "old" },
		options(65536),
	);
	try {
		const meta = getPulseMeta(p);
		const row = patchToRow(
			p.id,
			new CorePatch(65537, 1, 2, meta.model.schemaId, [
				{
					kind: 1,
					target: meta.model.root!.id,
					field: "body",
					value: prepareValue("new"),
				},
			]),
			meta.log.vector,
		);
		apply(p, [row]);
		expect(p.body.text).toBe("new");
	} finally {
		destroyPulse(p);
	}
});

test("reviewer v2: schema rich text fast apply cannot commit a batch then fail", () => {
	const def = definePulse("RichAtomicReview", object({ body: "string" }), {
		richTextPaths: [["body"]],
	}).materialize();
	const p = createPulse(
		def,
		{ id: "rich-atomic-review", body: "old" },
		options(65536),
	);
	try {
		const meta = getPulseMeta(p);
		const vector = meta.log.vector;
		const row1 = patchToRow(
			p.id,
			new CorePatch(65537, 1, 2, meta.model.schemaId, [
				{
					kind: 1,
					target: meta.model.root!.id,
					field: "body",
					value: prepareValue("new"),
				},
			]),
			vector,
		);
		const row2 = patchToRow(
			p.id,
			new CorePatch(65537, 2, 3, meta.model.schemaId, [
				{
					kind: 3,
					target: "65537:1:0",
					after: "65537:1:3",
					deletes: [],
					values: [prepareValue("!")],
				},
			]),
			[...vector, [65537, 2]],
		);
		const before = snapshotPulse(p);
		try {
			apply(p, [row1, row2]);
		} catch {
			expect(meta.log.vector).toEqual(vector);
			expect(snapshotPulse(p)).toEqual(before);
			return;
		}
		expect(p.body.text).toBe("new!");
	} finally {
		destroyPulse(p);
	}
});

test("reviewer v2: rich text annotations apply to array entries", () => {
	const def = definePulse(
		"ArrayRichReview",
		object({ items: array("string") }),
		{ richTextPaths: [["items", "*"]] },
	).materialize();
	const p = createPulse(
		def,
		{ id: "array-rich-review", items: ["hello"] },
		options(65536),
	);
	try {
		expect(p.items[0]!.text).toBe("hello");
	} finally {
		destroyPulse(p);
	}
});

test("reviewer v2: optional annotated rich text can remain absent", () => {
	const def = definePulse(
		"OptionalRichReview",
		object({ title: "string", body: optional("string") }),
		{ richTextPaths: [["body"]] },
	).materialize();
	let p: any;
	try {
		p = createPulse(
			def,
			{ id: "optional-rich-review", title: "title" },
			options(65536),
		);
		expect(p.body).toBeUndefined();
	} finally {
		if (p) destroyPulse(p);
	}
});

test("reviewer v2: typed non-finite remote floats are rejected atomically", () => {
	const def = definePulse(
		"FiniteReview",
		object({ value: "float64" }),
	).materialize();
	const p = createPulse(def, { id: "finite-review", value: 1 }, options(65536));
	try {
		const meta = getPulseMeta(p);
		const row = patchToRow(
			p.id,
			new CorePatch(65537, 1, 2, meta.model.schemaId, [
				{
					kind: 1,
					target: meta.model.root!.id,
					field: "value",
					value: { value: Infinity, constants: [], texts: [] },
				},
			]),
			meta.log.vector,
			meta.model.encoding,
		);
		const before = snapshotPulse(p);
		expect(() => apply(p, [row])).toThrow();
		expect(snapshotPulse(p)).toEqual(before);
	} finally {
		destroyPulse(p);
	}
});

test("reviewer v2: path-specific annotations apply below recursive layouts", () => {
	type RecursiveSchema = ObjectSchema<{
		value: "uint";
		child: OptionalSchema<() => RecursiveSchema>;
	}>;
	const schema: RecursiveSchema = object({
		value: "uint",
		child: optional(() => schema),
	});
	const def = definePulse("RecursiveConstantReview", schema, {
		constantPaths: [["child", "value"]],
	}).materialize();
	const p = createPulse(
		def,
		{ id: "recursive-constant-review", value: 1, child: { value: 2 } },
		options(65536),
	);
	try {
		expect(() => {
			(p as any).child.value = 3;
		}).toThrow();
	} finally {
		destroyPulse(p);
	}
});

test("reviewer v2: a version write cannot authorize rewriting pre-existing constants", () => {
	const schema = object({ fixed: object({ value: "uint" }) });
	const builder = definePulse("ConstantRewriteReview", schema, {
		constantPaths: [["fixed"]],
	});
	const def = builder.migrate<any>("no-op", () => ({})).materialize();
	const p = createPulse(
		def,
		{ id: "constant-rewrite-review", fixed: { value: 1 } },
		options(65536),
	);
	try {
		const meta = getPulseMeta(p);
		const fixed = prepareValue({ value: 99 });
		fixed.constants = [[]];
		const row = patchToRow(
			p.id,
			new CorePatch(65537, 1, 2, meta.model.schemaId, [
				{ kind: 1, target: meta.model.root!.id, field: "fixed", value: fixed },
				{
					kind: 1,
					target: meta.model.root!.id,
					field: "version",
					value: prepareValue(2),
				},
			]),
			meta.log.vector,
		);
		expect(() => apply(p, [row])).toThrow();
		expect((p as any).fixed.value).toBe(1);
	} finally {
		destroyPulse(p);
	}
});
