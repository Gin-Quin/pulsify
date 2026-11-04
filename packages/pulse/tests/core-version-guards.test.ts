import { expect, test } from "bun:test";
import { map, object, union } from "@gin-quin/codec";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	snapshotPulse,
} from "../source/index.js";
import { CorePatch } from "../source/core/operations.js";
import { schemaFingerprint } from "../source/core/schema.js";
import { prepareValue } from "../source/core/values.js";
import { patchToRow } from "../source/connection/PulsePatch.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";

const options = (sessionId: number) => ({
	...defaultPulseOptions,
	sessionId,
	scope: createPulseScope(),
});

test("versioned root unions retain their effective layout without repeated subtree retyping", () => {
	const schema = union({
		tagName: "type",
		tagType: "string",
		variants: { note: { nested: object({ count: "uint" }) } },
	});
	const builder = definePulse("UnionRetype", schema);
	const oldDefinition = builder.materialize();
	const latest = builder.migrate("keep shape", () => ({})).materialize();
	const source = createPulse(
		oldDefinition,
		{ type: "note", nested: { count: 1 } },
		options(65536),
	);
	const peer = createRuntime(latest, source.id, options(65537));
	try {
		const meta = getPulseMeta(peer),
			model = meta.model as any;
		const original = model.retype;
		let retypes = 0;
		model.retype = function (...args: any[]) {
			retypes++;
			return original.apply(this, args);
		};
		meta.applyRows(getPulseMeta(source).log.missing([]));
		expect(peer.version).toBe(2);
		expect(retypes).toBeGreaterThan(0);
		const migrated = retypes,
			layout = model.root.layout;
		for (let count = 2; count < 12; count++) (peer as any).nested.count = count;
		expect(retypes).toBe(migrated);
		expect(model.root.layout).toBe(layout);
		expect((peer as any).nested.count).toBe(11);
	} finally {
		destroyPulse(source);
		destroyPulse(peer);
	}
});

test("root fingerprints must match the declared stored version before initialization commits", () => {
	const builder = definePulse("VersionFingerprint", object({ count: "uint" }));
	const legacy = builder.materialize();
	const latest = builder
		.migrate("add title", () => ({ title: "latest" }) as any)
		.schema(object({ count: "uint", title: "string" }))
		.materialize();
	const oldSchema = schemaFingerprint(legacy.compiledSchema!),
		currentSchema = schemaFingerprint(latest.compiledSchema!);
	for (const [version, schema] of [
		[1, currentSchema],
		[2, oldSchema],
	] as const) {
		const target = createRuntime(latest, "version-fingerprint", options(65537)),
			meta = getPulseMeta(target);
		try {
			const value = prepareValue({
				id: meta.id,
				kind: latest.kind,
				version,
				generation: 0,
				count: 1,
				title: "latest",
			});
			const row = patchToRow(
				meta.id,
				new CorePatch(65536, 1, 1, schema, [{ kind: 0, value }]),
				[],
			);
			expect(() => meta.applyRows([row])).toThrow("stored version");
			expect(meta.log.size).toBe(0);
			expect(meta.log.vector).toEqual([]);
			expect(meta.model.root).toBeUndefined();
		} finally {
			destroyPulse(target);
		}
	}
	const fallback = { ...latest };
	delete fallback.schemas;
	const source = createPulse(
		fallback,
		{ count: 1, title: "latest" } as any,
		options(65536),
	);
	const target = createRuntime(fallback, source.id, options(65537));
	try {
		getPulseMeta(target).applyRows(getPulseMeta(source).log.missing([]));
		expect(snapshotPulse(target)).toEqual(snapshotPulse(source));
	} finally {
		destroyPulse(source);
		destroyPulse(target);
	}
});

test("runtime identity guards reject nonprimitive IDs and malformed kinds before scope registration", () => {
	const definition = definePulse(
		"RuntimeIdentity",
		object({ count: "uint" }),
	).materialize();
	for (const id of [42, new String("boxed"), {}, null, undefined]) {
		const config = options(65536);
		expect(() => createRuntime(definition, id as any, config)).toThrow(
			"Invalid pulse ID",
		);
		expect(config.scope.pulses.size).toBe(0);
	}
	for (const kind of [42, new String("boxed"), {}, null, undefined, "\ud800"]) {
		const config = options(65536);
		expect(() =>
			createRuntime({ ...definition, kind } as any, "runtime-identity", config),
		).toThrow("Invalid pulse kind");
		expect(config.scope.pulses.size).toBe(0);
	}
});

test("dynamic root map migrations normalize new keys and preserve concurrent constant captures", () => {
	const schema = map(object({ count: "uint" }));
	const builder = definePulse("RootMapMigration", schema),
		legacy = builder.materialize();
	const latest = builder
		.migrate("add and freeze entries", () => ({ added: { count: 2 } }) as any)
		.schema(schema, { constantPaths: [["*"]] })
		.materialize();
	const source = createPulse(legacy, { first: { count: 1 } }, options(65536));
	const a = createRuntime(latest, source.id, options(65537)),
		b = createRuntime(latest, source.id, options(65538));
	try {
		const base = getPulseMeta(source).log.missing([]),
			ma = getPulseMeta(a),
			mb = getPulseMeta(b);
		ma.applyRows(base);
		mb.applyRows(base);
		expect(a.version).toBe(2);
		expect((snapshotPulse(a) as any).added).toEqual({ count: 2 });
		ma.applyRows(mb.log.missing(ma.log.vector));
		mb.applyRows(ma.log.missing(mb.log.vector));
		expect(snapshotPulse(a)).toEqual(snapshotPulse(b));
		expect(() => {
			(a as any).first = { count: 3 };
		}).toThrow("constant");
		expect(() => {
			(a as any).first.count = 3;
		}).toThrow();
		const fresh = createRuntime(latest, source.id, options(65539));
		try {
			getPulseMeta(fresh).applyRows(ma.log.missing([]));
			expect(snapshotPulse(fresh)).toEqual(snapshotPulse(a));
		} finally {
			destroyPulse(fresh);
		}
	} finally {
		destroyPulse(source);
		destroyPulse(a);
		destroyPulse(b);
	}
});

test("remote root value markers cannot turn managed metadata into collaborative nodes", () => {
	const definition = definePulse(
		"MetadataMarkers",
		object({ count: "uint" }),
	).materialize();
	for (const marker of ["constants", "texts"] as const) {
		const target = createRuntime(
				definition,
				"metadata-markers",
				options(65537),
			),
			meta = getPulseMeta(target);
		try {
			const value = prepareValue({
				id: meta.id,
				kind: definition.kind,
				version: 1,
				generation: 0,
				count: 1,
			});
			value[marker] = [["id"]];
			const row = patchToRow(
				meta.id,
				new CorePatch(65536, 1, 1, meta.model.schemaId, [{ kind: 0, value }]),
				[],
				meta.model.encoding,
			);
			expect(() => meta.applyRows([row])).toThrow("metadata");
			expect(meta.log.size).toBe(0);
			expect(meta.model.root).toBeUndefined();
		} finally {
			destroyPulse(target);
		}
	}
});
