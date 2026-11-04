import { describe, expect, test } from "bun:test";
import { array, map, object, optional } from "@gin-quin/codec";
import {
	createPulse,
	createPulseScope,
	definePulse,
	destroyPulse,
	getPulseMeta,
	snapshotPulse,
	struct,
	type Struct,
	type DataFromDefinition,
	type ModelFromDefinition,
	type Pulse,
	type PulseProperties,
} from "../source/index.js";
import { createRuntime } from "../source/pulses/PulseRuntime.js";
import { defaultPulseOptions } from "../source/pulses/PulseOptions.js";
import type { AnyPulseDefinition } from "../source/pulses/PulseDefinition.js";
import type { PulsePatchRow } from "../source/connection/PulsePatch.js";
import {
	decodeMessage,
	encodeMessage,
} from "../source/connection/PulseMessage.js";

const options = (sessionId: number) => ({
	...defaultPulseOptions,
	sessionId,
	scope: createPulseScope(),
});
function emptyReplica<D extends AnyPulseDefinition>(
	definition: D,
	id: string,
	actor: number,
): Pulse<ModelFromDefinition<D>> {
	return createRuntime(definition, id, options(actor)) as Pulse<
		ModelFromDefinition<D>
	>;
}
function apply<P extends Pulse<PulseProperties<string>>>(
	target: P,
	rows: PulsePatchRow[],
): void {
	if (!rows.length) return;
	const message = decodeMessage(
		encodeMessage({
			kind: 4,
			docId: rows[0]!.docId,
			requestId: 0,
			vv: [],
			rows,
		}),
	);
	if (message.kind !== 4) throw new Error("Expected patch transport message");
	getPulseMeta(target).applyRows(message.rows);
}
const history = <P extends Pulse<PulseProperties<string>>>(pulse: P) =>
	getPulseMeta(pulse).log.missing([]);

describe("versioned typed document migrations", () => {
	test("loading typed v1 rows migrates to the registered v2 schema", () => {
		const schema1 = object({ name: "string", score: "uint" });
		const schema2 = object({ name: "string", score: "uint", email: "string" });
		type V2 = PulseProperties<"TypedMigrationLoad"> & {
			name: string;
			score: number;
			email: string;
		};
		let migrations = 0;
		const builder = definePulse("TypedMigrationLoad", schema1);
		const oldDefinition = builder.materialize();
		const latest = builder
			.migrate<V2>("add email", (before) => {
				migrations++;
				return { email: `${before.name.toLowerCase()}@example.com` };
			})
			.schema(schema2)
			.materialize();
		const source = createPulse(
			oldDefinition,
			{ id: "migration-load", name: "Ada", score: 7 },
			options(65536),
		);
		const current = emptyReplica(latest, source.id, 65537);
		try {
			apply(current, history(source));
			expect(current.version).toBe(2);
			expect(current.name).toBe("Ada");
			expect(current.score).toBe(7);
			expect(current.email).toBe("ada@example.com");
			expect(migrations).toBe(1);
			const vv = getPulseMeta(current).log.vector;
			apply(current, history(source));
			expect(migrations).toBe(1);
			expect(getPulseMeta(current).log.vector).toEqual(vv);
			current.email = "new@example.com";
			expect(current.email).toBe("new@example.com");
		} finally {
			destroyPulse(source);
			destroyPulse(current);
		}
	});

	test("latest edits replay from complete mixed-version binary history without repeating migrations", () => {
		const schema1 = object({ title: "string", count: "uint" });
		const schema2 = object({
			count: "uint",
			title: "string",
			active: "boolean",
		});
		type V2 = PulseProperties<"TypedMigrationReplay"> & {
			title: string;
			count: number;
			active: boolean;
		};
		let migrations = 0;
		const builder = definePulse("TypedMigrationReplay", schema1);
		const oldDefinition = builder.materialize();
		const latest = builder
			.migrate<V2>("activate", () => {
				migrations++;
				return { active: true };
			})
			.schema(schema2)
			.materialize();
		const source = createPulse(
			oldDefinition,
			{ id: "migration-replay", title: "Old", count: 1 },
			options(65536),
		);
		const current = emptyReplica(latest, source.id, 65537);
		const restored = emptyReplica(latest, source.id, 65538);
		try {
			apply(current, history(source));
			current.title = "Latest edit";
			current.count = 42;
			current.active = false;
			const rows = history(current);
			expect(migrations).toBe(1);
			apply(restored, rows);
			expect(migrations).toBe(1);
			expect(snapshotPulse(restored)).toEqual(snapshotPulse(current));
			expect(getPulseMeta(restored).log.vector).toEqual(
				getPulseMeta(current).log.vector,
			);
			apply(restored, [...rows].reverse());
			expect(snapshotPulse(restored)).toEqual(snapshotPulse(current));
			expect(migrations).toBe(1);
		} finally {
			for (const pulse of [source, current, restored]) destroyPulse(pulse);
		}
	});

	test("latest materialization stays bound after a typed migration and replay", () => {
		const schema1 = object({ name: "string", sourceEmail: "string" });
		const schema2 = object({
			sourceEmail: "string",
			name: "string",
			emailV2: "string",
		});
		type Data2 = PulseProperties<"TypedMaterialized"> & {
			name: string;
			sourceEmail: string;
			emailV2: string;
		};
		type Model = PulseProperties<"TypedMaterialized"> & {
			name: string;
			sourceEmail: string;
			email: string;
		};
		const builder = definePulse("TypedMaterialized", schema1);
		const oldDefinition = builder.materialize();
		const latest = builder
			.migrate<Data2>("store current email", (before) => ({
				emailV2: before.sourceEmail,
			}))
			.schema(schema2)
			.materialize<Model>(({ bind }) => ({ email: bind("emailV2") }));
		const source = createPulse(
			oldDefinition,
			{
				id: "migration-materialized",
				name: "Ada",
				sourceEmail: "old@example.com",
			},
			options(65536),
		);
		const current = emptyReplica(latest, source.id, 65537);
		const restored = emptyReplica(latest, source.id, 65538);
		try {
			apply(current, history(source));
			expect(current.email).toBe("old@example.com");
			expect(Object.keys(current)).not.toContain("emailV2");
			current.email = "new@example.com";
			expect(getPulseMeta(current).model.view().emailV2).toBe(
				"new@example.com",
			);
			apply(restored, history(current));
			expect(restored.email).toBe("new@example.com");
			expect(snapshotPulse(restored)).toEqual(snapshotPulse(current));
			expect(Object.keys(snapshotPulse(restored))).not.toContain("emailV2");
		} finally {
			for (const pulse of [source, current, restored]) destroyPulse(pulse);
		}
	});

	test("old-client edits address their original fields after nested schema reordering", () => {
		const schema1 = object({
			title: "string",
			stats: object({ count: "uint", label: "string" }),
		});
		const schema2 = object({
			stats: object({ label: "string", count: "uint" }),
			title: "string",
			status: "string",
		});
		type V2 = PulseProperties<"ReorderedMigration"> & {
			title: string;
			stats: { count: number; label: string };
			status: string;
		};
		const builder = definePulse("ReorderedMigration", schema1);
		const oldDefinition = builder.materialize();
		const latest = builder
			.migrate<V2>("status", () => ({ status: "ready" }))
			.schema(schema2)
			.materialize();
		const oldClient = createPulse(
			oldDefinition,
			{
				id: "migration-reordered",
				title: "Old title",
				stats: { count: 1, label: "Initial" },
			},
			options(65536),
		);
		const current = emptyReplica(latest, oldClient.id, 65537);
		const restored = emptyReplica(latest, oldClient.id, 65538);
		try {
			apply(current, history(oldClient));
			oldClient.stats.count = 9;
			oldClient.title = "Late v1 title";
			apply(current, history(oldClient));
			expect(current.stats.count).toBe(9);
			expect(current.stats.label).toBe("Initial");
			expect(current.title).toBe("Late v1 title");
			expect(current.status).toBe("ready");
			current.stats.label = "V2 label";
			current.stats.count = 10;
			apply(restored, history(current));
			expect(snapshotPulse(restored)).toEqual(snapshotPulse(current));
			expect(restored.stats).toEqual({ count: 10, label: "V2 label" });
		} finally {
			for (const pulse of [oldClient, current, restored]) destroyPulse(pulse);
		}
	});

	test("a new schema version can freeze an existing value and preserve it on replay", () => {
		const schema = object({
			name: "string",
			origin: object({ source: "string" }),
		});
		type Data = PulseProperties<"ConstantMigration"> & {
			name: string;
			origin: { source: string };
		};
		const builder = definePulse("ConstantMigration", schema);
		const oldDefinition = builder.materialize();
		const latest = builder
			.migrate<Data>("freeze origin", () => ({}))
			.schema(schema, { constantPaths: [["origin"]] })
			.materialize();
		const source = createPulse(
			oldDefinition,
			{ id: "migration-constant", name: "Ada", origin: { source: "import" } },
			options(65536),
		);
		const current = emptyReplica(latest, source.id, 65537);
		const restored = emptyReplica(latest, source.id, 65538);
		try {
			apply(current, history(source));
			expect(current.version).toBe(2);
			const vector = getPulseMeta(current).log.vector;
			expect(() =>
				Reflect.set(current, "origin", { source: "changed" }),
			).toThrow();
			expect(() => {
				Reflect.set(current.origin, "source", "changed");
			}).toThrow();
			expect(current.origin.source).toBe("import");
			expect(getPulseMeta(current).log.vector).toEqual(vector);
			current.name = "Bob";
			apply(restored, history(current));
			expect(snapshotPulse(restored)).toEqual(snapshotPulse(current));
			expect(() =>
				Reflect.set(restored, "origin", { source: "changed after replay" }),
			).toThrow();
			expect(() => {
				Reflect.set(restored.origin, "source", "changed after replay");
			}).toThrow();
			expect(restored.origin.source).toBe("import");
		} finally {
			for (const pulse of [source, current, restored]) destroyPulse(pulse);
		}
	});

	test("a same-shape migration preserves compatibility while old clients reject its future version", () => {
		const schema = object({ name: "string" });
		type Data = PulseProperties<"SameShapeMigration"> & { name: string };
		const builder = definePulse("SameShapeMigration", schema);
		const oldDefinition = builder.materialize();
		const latest = builder
			.migrate<Data>("uppercase", (before) => ({
				name: before.name.toUpperCase(),
			}))
			.materialize();
		const source = createPulse(
			oldDefinition,
			{ id: "migration-same-shape", name: "Ada" },
			options(65536),
		);
		const current = emptyReplica(latest, source.id, 65537);
		const restored = emptyReplica(latest, source.id, 65538);
		try {
			apply(current, history(source));
			expect(current.name).toBe("ADA");
			expect(current.version).toBe(2);
			expect(getPulseMeta(source).model.schemaId).toBe(
				getPulseMeta(current).model.schemaId,
			);
			const before = snapshotPulse(source);
			const vector = getPulseMeta(source).log.vector;
			expect(() => apply(source, history(current))).toThrow();
			expect(snapshotPulse(source)).toEqual(before);
			expect(getPulseMeta(source).log.vector).toEqual(vector);
			apply(restored, history(current));
			expect(snapshotPulse(restored)).toEqual(snapshotPulse(current));
		} finally {
			for (const pulse of [source, current, restored]) destroyPulse(pulse);
		}
	});

	test("old clients reject a different future schema atomically", () => {
		const schema1 = object({ name: "string" });
		const schema2 = object({ name: "string", active: "boolean" });
		type V2 = PulseProperties<"FutureSchemaMigration"> & {
			name: string;
			active: boolean;
		};
		const builder = definePulse("FutureSchemaMigration", schema1);
		const oldDefinition = builder.materialize();
		const latest = builder
			.migrate<V2>("activate", () => ({ active: true }))
			.schema(schema2)
			.materialize();
		const source = createPulse(
			oldDefinition,
			{ id: "migration-future", name: "Ada" },
			options(65536),
		);
		const current = emptyReplica(latest, source.id, 65537);
		try {
			apply(current, history(source));
			const before = snapshotPulse(source);
			const vector = getPulseMeta(source).log.vector;
			expect(() => apply(source, history(current))).toThrow();
			expect(snapshotPulse(source)).toEqual(before);
			expect(getPulseMeta(source).log.vector).toEqual(vector);
		} finally {
			destroyPulse(source);
			destroyPulse(current);
		}
	});

	test("invalid typed migration output cannot append a local patch or advance its actor clock", () => {
		const schema1 = object({ name: "string" });
		const schema2 = object({ name: "string", count: "uint" });
		type V2 = PulseProperties<"InvalidTypedMigration"> & {
			name: string;
			count: number;
		};
		const builder = definePulse("InvalidTypedMigration", schema1);
		const oldDefinition = builder.materialize();
		const latest = builder
			.migrate<V2>("invalid count", () => ({
				count: "invalid" as unknown as number,
			}))
			.schema(schema2)
			.materialize();
		const source = createPulse(
			oldDefinition,
			{ id: "migration-invalid-count", name: "Ada" },
			options(65536),
		);
		const current = emptyReplica(latest, source.id, 65537);
		try {
			const sourceVector = getPulseMeta(source).log.vector;
			expect(() => apply(current, history(source))).toThrow("schema layout");
			expect(getPulseMeta(current).log.vector).toEqual(sourceVector);
			expect(getPulseMeta(current).model.nextClock).toBe(1);
			expect(getPulseMeta(current).log.pendingCount).toBe(0);
			expect(getPulseMeta(current).model.view()).toEqual(
				getPulseMeta(source).model.view(),
			);
		} finally {
			destroyPulse(source);
			destroyPulse(current);
		}
	});

	test("a failing later migration leaves earlier migration changes uncommitted", () => {
		const schema1 = object({ name: "string" });
		const schema2 = object({ name: "string", active: "boolean" });
		const schema3 = object({
			name: "string",
			active: "boolean",
			label: "string",
		});
		type V2 = PulseProperties<"AtomicMigrationChain"> & {
			name: string;
			active: boolean;
		};
		type V3 = V2 & { label: string };
		const builder = definePulse("AtomicMigrationChain", schema1);
		const oldDefinition = builder.materialize();
		let calls = 0;
		const latest = builder
			.migrate<V2>("active", () => {
				calls++;
				return { active: true };
			})
			.schema(schema2)
			.migrate<V3>("fails", () => {
				calls++;
				throw new Error("Migration fixture failed");
			})
			.schema(schema3)
			.materialize();
		const source = createPulse(
			oldDefinition,
			{ id: "migration-atomic-chain", name: "Ada" },
			options(65536),
		);
		const current = emptyReplica(latest, source.id, 65537);
		try {
			expect(() => apply(current, history(source))).toThrow(
				"Migration fixture failed",
			);
			expect(calls).toBe(2);
			expect(getPulseMeta(current).log.vector).toEqual(
				getPulseMeta(source).log.vector,
			);
			expect(getPulseMeta(current).model.nextClock).toBe(1);
			expect(getPulseMeta(current).model.view()).toEqual(
				getPulseMeta(source).model.view(),
			);
			expect("active" in current).toBe(false);
		} finally {
			destroyPulse(source);
			destroyPulse(current);
		}
	});

	test("a migration cannot rewrite an existing constant value", () => {
		const schema = object({
			name: "string",
			origin: object({ source: "string" }),
		});
		type Data = PulseProperties<"ImmutableMigration"> & {
			name: string;
			origin: { source: string };
		};
		const builder = definePulse("ImmutableMigration", schema, {
			constantPaths: [["origin"]],
		});
		const oldDefinition = builder.materialize();
		const latest = builder
			.migrate<Data>("illegal rewrite", () => ({
				origin: { source: "changed" },
			}))
			.materialize();
		const source = createPulse(
			oldDefinition,
			{ id: "migration-immutable", name: "Ada", origin: { source: "import" } },
			options(65536),
		);
		const current = emptyReplica(latest, source.id, 65537);
		try {
			expect(() => apply(current, history(source))).toThrow(
				"constant field origin",
			);
			expect(current.origin.source).toBe("import");
			expect(current.version).toBe(1);
			expect(getPulseMeta(current).log.vector).toEqual(
				getPulseMeta(source).log.vector,
			);
			expect(getPulseMeta(current).model.nextClock).toBe(1);
		} finally {
			destroyPulse(source);
			destroyPulse(current);
		}
	});

	test("concurrent constant upgrades exchange their initialization captures and converge", () => {
		const schema = object({
			name: "string",
			origin: object({ source: "string" }),
		});
		type Data = PulseProperties<"ConcurrentConstantMigration"> & {
			name: string;
			origin: { source: string };
		};
		const builder = definePulse("ConcurrentConstantMigration", schema);
		const oldDefinition = builder.materialize();
		const latest = builder
			.migrate<Data>("freeze", () => ({}))
			.schema(schema, { constantPaths: [["origin"]] })
			.materialize();
		const source = createPulse(
			oldDefinition,
			{
				id: "migration-concurrent-constant",
				name: "Ada",
				origin: { source: "import" },
			},
			options(65536),
		);
		const a = emptyReplica(latest, source.id, 65537);
		const b = emptyReplica(latest, source.id, 65538);
		try {
			const base = history(source);
			apply(a, base);
			apply(b, base);
			const rows = [...history(a), ...history(b)];
			apply(a, [...rows].reverse());
			apply(b, rows);
			expect(snapshotPulse(a)).toEqual(snapshotPulse(b));
			expect(getPulseMeta(a).log.vector).toEqual(getPulseMeta(b).log.vector);
			expect(a.origin.source).toBe("import");
			expect(() => {
				Reflect.set(a.origin, "source", "changed");
			}).toThrow();
		} finally {
			for (const pulse of [source, a, b]) destroyPulse(pulse);
		}
	});

	test("late v1 child edits cannot change a captured constant in either delivery order", () => {
		const schema = object({
			name: "string",
			origin: object({ source: "string" }),
		});
		type Data = PulseProperties<"LateConstantMigration"> & {
			name: string;
			origin: { source: string };
		};
		const builder = definePulse("LateConstantMigration", schema);
		const oldDefinition = builder.materialize();
		const latest = builder
			.migrate<Data>("freeze", () => ({}))
			.schema(schema, { constantPaths: [["origin"]] })
			.materialize();
		const source = createPulse(
			oldDefinition,
			{
				id: "migration-late-constant",
				name: "Ada",
				origin: { source: "import" },
			},
			options(65536),
		);
		const author = emptyReplica(latest, source.id, 65537);
		const before = emptyReplica(latest, source.id, 65538);
		const after = emptyReplica(latest, source.id, 65539);
		try {
			const base = history(source);
			const baseVector = getPulseMeta(source).log.vector;
			apply(author, base);
			const capture = getPulseMeta(author).log.missing(baseVector);
			source.origin.source = "late first";
			source.origin.source = "late second";
			const late = getPulseMeta(source).log.missing(baseVector);
			apply(before, [...base, ...late, ...capture]);
			apply(after, [...base, ...capture]);
			apply(after, late);
			expect(before.origin.source).toBe("import");
			expect(after.origin.source).toBe("import");
			expect(snapshotPulse(before)).toEqual(snapshotPulse(after));
			expect(getPulseMeta(before).log.vector).toEqual(
				getPulseMeta(after).log.vector,
			);
		} finally {
			for (const pulse of [source, author, before, after]) destroyPulse(pulse);
		}
	});

	test("different concurrent constant captures choose the same stamp winner", () => {
		const schema = object({ origin: object({ source: "string" }) });
		type Data = PulseProperties<"DifferentConstantCaptures"> & {
			origin: { source: string };
		};
		const builder = definePulse("DifferentConstantCaptures", schema);
		const oldDefinition = builder.materialize();
		const latest = builder
			.migrate<Data>("freeze", () => ({}))
			.schema(schema, { constantPaths: [["origin"]] })
			.materialize();
		const source = createPulse(
			oldDefinition,
			{ id: "migration-different-captures", origin: { source: "initial" } },
			options(65536),
		);
		const a = emptyReplica(latest, source.id, 65537);
		const b = emptyReplica(latest, source.id, 65538);
		try {
			apply(a, history(source));
			source.origin.source = "observed by later migration";
			apply(b, history(source));
			expect(a.origin.source).toBe("initial");
			expect(b.origin.source).toBe("observed by later migration");
			const rows = [...history(a), ...history(b)];
			apply(a, [...rows].reverse());
			apply(b, rows);
			expect(a.origin.source).toBe("observed by later migration");
			expect(snapshotPulse(a)).toEqual(snapshotPulse(b));
			expect(getPulseMeta(a).log.vector).toEqual(getPulseMeta(b).log.vector);
		} finally {
			for (const pulse of [source, a, b]) destroyPulse(pulse);
		}
	});

	test("a string-to-rich-text annotation migration captures a collaborative text node", () => {
		const schema = object({ body: "string" });
		type Data = PulseProperties<"RichAnnotationMigration"> & { body: string };
		const builder = definePulse("RichAnnotationMigration", schema);
		const oldDefinition = builder.materialize();
		const latest = builder
			.migrate<Data>("rich body", () => ({}))
			.schema(schema, { richTextPaths: [["body"]] })
			.materialize();
		const source = createPulse(
			oldDefinition,
			{ id: "migration-rich-annotation", body: "Hello" },
			options(65536),
		);
		const current = emptyReplica(latest, source.id, 65537);
		const restored = emptyReplica(latest, source.id, 65538);
		try {
			apply(current, history(source));
			current.body.insert(5, "!");
			current.body.format(0, 5, { bold: true });
			apply(restored, history(current));
			expect(restored.body.text).toBe("Hello!");
			expect(restored.body.toDelta()).toEqual(current.body.toDelta());
			expect(snapshotPulse(restored)).toEqual(snapshotPulse(current));
		} finally {
			for (const pulse of [source, current, restored]) destroyPulse(pulse);
		}
	});

	test("binary leaves inside struct constants are detached on every public read", () => {
		type Data = PulseProperties<"BinaryConstantView"> & {
			fixed: Struct<{ bytes: Uint8Array; nested: { bytes: Uint8Array } }>;
		};
		const definition = definePulse<Data>("BinaryConstantView").materialize();
		const pulse = createPulse(
			definition,
			{
				id: "constant-binary-view",
				fixed: struct({
					bytes: new Uint8Array([1, 2]),
					nested: { bytes: new Uint8Array([3, 4]) },
				}),
			},
			options(65536),
		);
		try {
			const vector = getPulseMeta(pulse).log.vector;
			const clock = getPulseMeta(pulse).model.nextClock;
			const view = pulse.fixed;
			Reflect.set(view.bytes, "0", 99);
			Reflect.set(view.nested.bytes, "0", 99);
			expect(() =>
				Reflect.set(view, "nested", { bytes: new Uint8Array([9]) }),
			).toThrow();
			expect(pulse.fixed.bytes).toEqual(new Uint8Array([1, 2]));
			expect(pulse.fixed.nested.bytes).toEqual(new Uint8Array([3, 4]));
			expect(getPulseMeta(pulse).log.vector).toEqual(vector);
			expect(getPulseMeta(pulse).model.nextClock).toBe(clock);
		} finally {
			destroyPulse(pulse);
		}
	});

	test("nested annotation upgrades capture enclosing fields with concrete array and map paths", () => {
		const schema = object({
			profile: object({ origin: object({ source: "string" }), bio: "string" }),
			items: array(object({ id: "string" })),
			labels: map(optional("string")),
			fixed: map(object({ count: "uint" })),
		});
		const builder = definePulse("NestedCollectionAnnotations", schema);
		const oldDefinition = builder.materialize();
		type Data = DataFromDefinition<typeof oldDefinition>;
		const latest = builder
			.migrate<Data>("annotate nested values", () => ({}))
			.schema(schema, {
				constantPaths: [
					["profile", "origin"],
					["items", "*"],
					["fixed", "*"],
				],
				richTextPaths: [
					["profile", "bio"],
					["labels", "*"],
				],
			})
			.materialize();
		const source = createPulse(
			oldDefinition,
			{
				id: "migration-nested-collection",
				profile: { origin: { source: "import" }, bio: "Bio" },
				items: [{ id: "a" }],
				labels: { first: "Hello", absent: undefined },
				fixed: { first: { count: 1 } },
			},
			options(65536),
		);
		const current = emptyReplica(latest, source.id, 65537);
		const restored = emptyReplica(latest, source.id, 65538);
		try {
			apply(current, history(source));
			current.profile.bio.insert(3, "!");
			current.labels["first"]!.format(0, 5, { bold: true });
			expect(current.labels["absent"]).toBeUndefined();
			expect(() =>
				Reflect.set(current.profile.origin, "source", "changed"),
			).toThrow();
			expect(() => Reflect.set(current.items[0]!, "id", "changed")).toThrow();
			expect(() => Reflect.set(current.fixed["first"]!, "count", 2)).toThrow();
			apply(restored, history(current));
			expect(snapshotPulse(restored)).toEqual(snapshotPulse(current));
			expect(restored.profile.bio.text).toBe("Bio!");
			expect(restored.labels["first"]!.toDelta()).toEqual(
				current.labels["first"]!.toDelta(),
			);
		} finally {
			for (const pulse of [source, current, restored]) destroyPulse(pulse);
		}
	});

	test("nested constant captures ignore late edits independently of delivery order", () => {
		const schema = object({
			profile: object({
				origin: object({ source: "string" }),
				label: "string",
			}),
		});
		const builder = definePulse("NestedCaptureOrders", schema);
		const oldDefinition = builder.materialize();
		type Data = DataFromDefinition<typeof oldDefinition>;
		const latest = builder
			.migrate<Data>("freeze origin", () => ({}))
			.schema(schema, { constantPaths: [["profile", "origin"]] })
			.materialize();
		const source = createPulse(
			oldDefinition,
			{
				id: "migration-nested-orders",
				profile: { origin: { source: "initial" }, label: "Profile" },
			},
			options(65536),
		);
		const author = emptyReplica(latest, source.id, 65537);
		const before = emptyReplica(latest, source.id, 65538);
		const after = emptyReplica(latest, source.id, 65539);
		try {
			const base = history(source);
			const vector = getPulseMeta(source).log.vector;
			apply(author, base);
			const capture = getPulseMeta(author).log.missing(vector);
			source.profile.origin.source = "late first";
			source.profile.origin.source = "late second";
			const late = getPulseMeta(source).log.missing(vector);
			apply(before, [...base, ...late, ...capture]);
			apply(after, [...base, ...capture]);
			apply(after, late);
			expect(before.profile.origin.source).toBe("initial");
			expect(after.profile.origin.source).toBe("initial");
			expect(snapshotPulse(before)).toEqual(snapshotPulse(after));
			expect(getPulseMeta(before).log.vector).toEqual(
				getPulseMeta(after).log.vector,
			);
		} finally {
			for (const pulse of [source, author, before, after]) destroyPulse(pulse);
		}
	});

	for (const nested of [false, true])
		test(`removing a ${nested ? "nested" : "root"} constant annotation rejects the migration before commit`, () => {
			const schema = object({
				profile: object({ origin: object({ source: "string" }) }),
			});
			const builder = definePulse("ConstantAnnotationRemoval", schema, {
				constantPaths: nested ? [["profile", "origin"]] : [["profile"]],
			});
			const oldDefinition = builder.materialize();
			type Data = DataFromDefinition<typeof oldDefinition>;
			const latest = builder
				.migrate<Data>("invalid unfreeze", () => ({}))
				.schema(schema)
				.materialize();
			const source = createPulse(
				oldDefinition,
				{
					id: `migration-unfreeze-${nested}`,
					profile: { origin: { source: "initial" } },
				},
				options(65536),
			);
			const current = emptyReplica(latest, source.id, 65537);
			try {
				expect(() => apply(current, history(source))).toThrow(
					"cannot make constant field",
				);
				expect(getPulseMeta(current).model.view()).toEqual(
					getPulseMeta(source).model.view(),
				);
				expect(getPulseMeta(current).log.vector).toEqual(
					getPulseMeta(source).log.vector,
				);
				expect(getPulseMeta(current).model.nextClock).toBe(1);
			} finally {
				destroyPulse(source);
				destroyPulse(current);
			}
		});

	test("a constant retired from the schema remains immutable legacy data", () => {
		const oldSchema = object({
			name: "string",
			origin: object({ source: "string" }),
		});
		const latestSchema = object({ name: "string" });
		const builder = definePulse("RetiredConstant", oldSchema, {
			constantPaths: [["origin"]],
		});
		const oldDefinition = builder.materialize();
		type LatestData = PulseProperties<"RetiredConstant"> & { name: string };
		const latest = builder
			.migrate<LatestData>("retire origin", () => ({}))
			.schema(latestSchema)
			.materialize();
		const source = createPulse(
			oldDefinition,
			{
				id: "migration-retired-constant",
				name: "Ada",
				origin: { source: "initial" },
			},
			options(65536),
		);
		const current = emptyReplica(latest, source.id, 65537);
		const restored = emptyReplica(latest, source.id, 65538);
		try {
			apply(current, history(source));
			expect(current.version).toBe(2);
			const origin: unknown = Reflect.get(current, "origin");
			expect(origin).toEqual({ source: "initial" });
			expect(() =>
				Reflect.set(origin as object, "source", "changed"),
			).toThrow();
			apply(restored, history(current));
			expect(snapshotPulse(restored)).toEqual(snapshotPulse(current));
		} finally {
			for (const pulse of [source, current, restored]) destroyPulse(pulse);
		}
	});
});
