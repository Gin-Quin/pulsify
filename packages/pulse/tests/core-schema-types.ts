import {
	array,
	literal,
	object,
	optional,
	tuple,
	union,
	createCodec,
	map,
	type InferType,
} from "@gin-quin/codec";
import { createPulse } from "../source/pulses/createPulse.js";
import { definePulse } from "../source/pulses/PulseDefinition.js";
import { createPulseScope } from "../source/pulses/PulseOptions.js";
import { richText } from "../source/core/richText.js";
import { arrayOperations } from "../source/pulses/PulseArray.js";
import { snapshotPulse, type PulseSnapshot } from "../source/pulses/Pulse.js";
import { Buffer } from "node:buffer";
import type { PulseProperties } from "../source/pulses/PulseProperties.js";
import type { RichText } from "../source/core/richText.js";
import { struct, type Struct } from "../source/utilities/Struct.js";
import {
	tuple as constantTuple,
	type Tuple,
} from "../source/utilities/Tuple.js";

/** These assertions are checked by tsc and are intentionally not executed. */
export function schemaTypeAssertions(): void {
	const schema = object({
		name: "string",
		count: "uint",
		fixed: object({ revision: "uint" }),
		items: array(object({ id: "string", label: "string" })),
		mode: literal("typed"),
		description: optional("string"),
	});
	const definition = definePulse("SchemaTypes", schema, {
		constantPaths: [["fixed"], ["items", "*", "id"]],
	}).materialize();
	const pulse = createPulse(
		definition,
		{
			name: "Ada",
			count: 1,
			fixed: { revision: 2 },
			items: [{ id: "a", label: "A" }],
			mode: "typed",
		},
		{ scope: createPulseScope() },
	);
	pulse.name = "Bob";
	pulse.count = 3;
	pulse.items[0]!.label = "B";
	pulse.description = "Optional";
	// @ts-expect-error The schema field is numeric.
	pulse.count = "bad";
	// @ts-expect-error Constant fields cannot be rebound.
	pulse.fixed = { revision: 3 };
	// @ts-expect-error Constant fields are deeply readonly.
	pulse.fixed.revision = 3;
	// @ts-expect-error Wildcard paths make the field readonly in every array item.
	pulse.items[0]!.id = "b";
	// @ts-expect-error Literal fields are implicitly constant, including same-value assignments.
	pulse.mode = "typed";
	// @ts-expect-error No undeclared field exists in the schema.
	pulse.unknown = true;
	// @ts-expect-error Required codec fields remain required in creation input.
	createPulse(definition, { name: "Ada" });
	createPulse(definition, {
		name: "Ada",
		// @ts-expect-error Wrong field type in creation input.
		count: "1",
		fixed: { revision: 2 },
		items: [],
		mode: "typed",
	});
	// @ts-expect-error Pulse definitions require an object-shaped root.
	definePulse("Invalid", "string");
	const viaBuilder = definePulse("BuilderTypes")
		.schema(object({ value: "string" }))
		.materialize();
	const builderPulse = createPulse(
		viaBuilder,
		{ value: "A" },
		{ scope: createPulseScope() },
	);
	builderPulse.value = "B";
	// @ts-expect-error Builder schema inference also preserves the field type.
	builderPulse.value = 3;
	const RichDefinition = definePulse(
		"RichTypes",
		object({ body: "string", optional: optional("string") }),
		{
			richTextPaths: [["body"], ["optional"]],
		},
	).materialize();
	const rich = createPulse(
		RichDefinition,
		{ body: richText("Hi") },
		{ scope: createPulseScope() },
	);
	createPulse(
		RichDefinition,
		{ body: "Initial text" },
		{ scope: createPulseScope() },
	);
	rich.body.insert(2, "!");
	rich.body.format(0, 2, { bold: true });
	rich.optional?.delete(0, 1);
	// @ts-expect-error Rich text is a collaborative view, not a primitive number.
	rich.body = 2;
	// @ts-expect-error Rich text mutation requires a string insertion.
	rich.body.insert(0, 3);

	const Tuples = definePulse(
		"TupleTypes",
		object({
			pair: tuple("uint", "string"),
			nested: tuple(
				tuple("boolean", "string"),
				object({ values: array("uint") }),
			),
			list: array(object({ values: array("uint") })),
		}),
	).materialize();
	const tuples = createPulse(
		Tuples,
		{
			pair: [1, "A"],
			nested: [[true, "A"], { values: [1] }],
			list: [{ values: [1] }],
		},
		{ scope: createPulseScope() },
	);
	tuples.pair[0] = 2;
	tuples.pair[1] = "B";
	const length: 2 = tuples.pair.length;
	void length;
	// @ts-expect-error Tuple positions retain their individual codec types.
	tuples.pair[0] = "wrong";
	// @ts-expect-error Tuple positions retain their individual codec types.
	tuples.pair[1] = 2;
	// @ts-expect-error Known out-of-bounds tuple access is rejected.
	tuples.pair[2] = 3;
	// Plain tuples, arrays and objects containing arrays remain assignable.
	tuples.pair = [3, "C"];
	tuples.nested = [[false, "B"], { values: [2, 3] }];
	tuples.list = [{ values: [2, 3] }];
	tuples.list[0] = { values: [] };
	arrayOperations(tuples.pair).replaceAll([4, "D"]);
	// @ts-expect-error Tuple replacement requires the exact positional types.
	arrayOperations(tuples.pair).replaceAll(["D", 4]);
	// @ts-expect-error Tuple replacement preserves cardinality.
	arrayOperations(tuples.pair).replaceAll([4, "D", 5]);
	// @ts-expect-error Collection insertion helpers are unavailable for fixed tuples.
	arrayOperations(tuples.pair).insert(0, [4, "D"]);
	arrayOperations(tuples.list).replaceAll([{ values: [4] }]);
	arrayOperations(tuples.list).insert(0, [{ values: [5] }]);
	const removed: { values: number[] }[] = arrayOperations(tuples.list).delete(
		0,
		1,
	);
	void removed;
	const snapshot = snapshotPulse(tuples);
	const plain: [number, string] = snapshot.pair;
	const nested: [[boolean, string], { values: number[] }] = snapshot.nested;
	void plain;
	void nested;
	// @ts-expect-error Detached tuple snapshots retain their positional types.
	snapshot.pair[0] = "wrong";
	// @ts-expect-error Ordinary arrays do not require or expose pulse helper members.
	tuples.list.replaceAll([]);

	const Binary = definePulse(
		"ReadonlyBytes",
		object({ fixed: "uint8Array", live: "uint8Array" }),
		{
			constantPaths: [["fixed"]],
		},
	).materialize();
	const binary = createPulse(
		Binary,
		{ fixed: new Uint8Array([1]), live: new Uint8Array([2]) },
		{ scope: createPulseScope() },
	);
	// @ts-expect-error Pulsify preserves readonly indices for constant binary fields.
	binary.fixed[0] = 3;
	// @ts-expect-error Constant binary fields cannot be rebound.
	binary.fixed = new Uint8Array([3]);
	binary.live[0] = 3;
	const mutableBytes: Uint8Array = snapshotPulse(binary).fixed;
	mutableBytes[0] = 4;
	type BufferDocument = PulseProperties<"BufferTypes"> & { bytes: Buffer };
	const BufferDocument =
		definePulse<BufferDocument>("BufferTypes").materialize();
	const bufferDocument = createPulse(
		BufferDocument,
		{ bytes: Buffer.from([1, 2]) },
		{ scope: createPulseScope() },
	);
	bufferDocument.bytes[0] = 3;
	const standardBytes: Uint8Array = bufferDocument.bytes;
	void standardBytes;
	// @ts-expect-error Normalized binary values expose Uint8Array, not Buffer-specific methods.
	bufferDocument.bytes.readUInt32LE(0);
	const snapshotBytes: Uint8Array = snapshotPulse(bufferDocument).bytes;
	void snapshotBytes;

	const documents = union({
		tagName: "kind",
		tagType: "string",
		variants: {
			DocA: {
				id: "string",
				version: "uint",
				generation: "uint",
				title: "string",
				common: "string",
			},
			DocB: {
				id: "string",
				version: "uint",
				generation: "uint",
				count: "uint",
				common: "string",
			},
		},
	});
	const DocA = definePulse("DocA", documents).materialize();
	const a = createPulse(
		DocA,
		{ title: "A", common: "Shared" },
		{ scope: createPulseScope() },
	);
	a.title = "Edited";
	const kindA: "DocA" = a.kind;
	void kindA;
	// @ts-expect-error DocB's branch is excluded when the document kind is DocA.
	a.count = 1;
	// @ts-expect-error Creation input must use the selected DocA branch.
	createPulse(DocA, { count: 1, common: "Shared" });
	// @ts-expect-error Managed schema metadata is still supplied only by Pulsify.
	createPulse(DocA, { title: "A", common: "Shared", kind: "DocB" });
	const DocB = definePulse("DocB", documents).materialize();
	createPulse(
		DocB,
		{ count: 1, common: "Shared" },
		{ scope: createPulseScope() },
	);
	const FluentA = definePulse("DocA").schema(documents).materialize();
	createPulse(
		FluentA,
		{ title: "A", common: "Shared" },
		{ scope: createPulseScope() },
	);
	// @ts-expect-error Fluent schema selection also excludes the DocB branch.
	createPulse(FluentA, { count: 1, common: "Shared" });
	// @ts-expect-error A schema whose literal kind cannot encode DocA is incompatible.
	definePulse("DocA", object({ kind: literal("DocB"), title: "string" }));
	definePulse("DocA").schema(
		// @ts-expect-error Fluent schema selection enforces the same metadata kind.
		object({ kind: literal("DocB"), title: "string" }),
	);
}

/** Schema-first migrations infer both callbacks and the final public model. */
export function migrationSchemaTypeAssertions(): void {
	const v1 = object({ title: "string", count: "string" });
	const v2 = object({ title: "string", count: "uint", published: "boolean" });
	const v3 = object({ heading: "string", count: "uint", published: "boolean" });
	const builder = definePulse("MigrationTypes", v1);
	// @ts-expect-error Migrations no longer accept a name argument.
	builder.migrateTo(v2, "removed-name");
	// @ts-expect-error The legacy typed method also accepts only the callback.
	builder.migrate("removed-name");
	// @ts-expect-error Schema-based transitions use migrateTo, not the legacy migrate method.
	builder.migrate(v2, "renamed method", () => ({ count: 0, published: false }));
	const latest = builder
		.migrateTo(v2, (before) => {
			const count: string = before.count;
			// @ts-expect-error The first callback receives V1, which has no published field.
			before.published;
			return { count: Number(count), published: false };
		})
		.migrateTo(v3, (before) => {
			const count: number = before.count;
			const published: boolean = before.published;
			// @ts-expect-error The second callback receives the numeric V2 field.
			const text: string = before.count;
			void text;
			return { heading: before.title, count, published };
		})
		.materialize();
	const pulse = createPulse(latest, {
		heading: "Latest",
		count: 1,
		published: false,
	});
	pulse.heading = "Edited";
	pulse.count = 2;
	pulse.published = true;
	const kind: "MigrationTypes" = pulse.kind;
	void kind;
	// @ts-expect-error Final field types are inferred from V3, not widened to any.
	pulse.count = "bad";
	// @ts-expect-error Fields omitted from the final schema are absent from its type.
	pulse.title;
	// @ts-expect-error Creation requires the latest schema's heading field.
	createPulse(latest, { title: "Old", count: 1, published: false });
	// @ts-expect-error Creation still requires the published field.
	createPulse(latest, { heading: "Latest", count: 1 });
	// @ts-expect-error Migrations must supply newly required fields.
	builder.migrateTo(v2, () => ({ count: 1 }));
	// @ts-expect-error Migrations must supply fields whose type changes.
	builder.migrateTo(v2, () => ({ published: false }));
	builder.migrateTo(v2, () => ({
		// @ts-expect-error The callback cannot widen the schema's numeric field to string.
		count: "1",
		published: false,
	}));
	builder.migrateTo(v2, () => ({
		count: 1,
		published: false,
		// @ts-expect-error Migrations cannot write managed metadata.
		version: 2,
	}));
	// @ts-expect-error A migration target must have an object-shaped root.
	builder.migrateTo("string", () => ({}));
	builder.migrateTo(
		// @ts-expect-error The target schema cannot change the pulse kind.
		object({ kind: literal("Other") }),
		() => ({}),
	);

	type Model = PulseProperties<"MigrationTypes"> & {
		name: string;
		count: number;
		published: boolean;
	};
	const materialized = builder
		.migrateTo(v2, () => ({
			count: 0,
			published: false,
		}))
		.materialize<Model>(({ bind }) => ({ name: bind("title") }));
	const view = createPulse(materialized, {
		title: "Draft",
		count: 0,
		published: false,
	});
	view.name = "Edited";
	// @ts-expect-error The materializer receives the inferred V2 numeric field.
	view.count = "bad";
	// @ts-expect-error Creation accepts document fields, not materialized aliases.
	createPulse(materialized, { name: "Draft", count: 0, published: false });

	const annotated = definePulse(
		"MigrationAnnotations",
		object({ body: "string" }),
	)
		.migrateTo(
			object({ body: "string", origin: "string" }),
			(before) => ({
				body: `${before.body}!`,
				origin: "import",
			}),
			{
				richTextPaths: [["body"]],
				constantPaths: [["origin"]],
			},
		)
		.materialize();
	const rich = createPulse(annotated, { body: "Hello", origin: "import" });
	rich.body.insert(5, "!");
	// @ts-expect-error Rich-text annotations are inferred in the final model.
	rich.body.insert(0, 1);
	// @ts-expect-error Constant annotations are inferred in the final model.
	rich.origin = "changed";
}

/** Inline rich-text schema inference stays distinct from codec's string data. */
export function inlineRichTextTypeAssertions(): void {
	const schema = object({
		title: "string",
		count: "float64",
		done: "boolean",
		author: object({ name: "string", bio: richText() }),
		tags: array("string"),
		body: richText(),
		paragraphs: array(richText()),
		nested: array(object({ text: richText() })),
		optional: optional(richText()),
		byId: map(richText()),
		pair: tuple(richText(), "uint"),
	});
	const definition = definePulse("InlineSchemaTypes", schema).materialize();
	const data = {
		title: "Draft",
		count: 0,
		done: false,
		author: { name: "Ada", bio: "Bio" },
		tags: [],
		body: "Hello",
		paragraphs: ["First"],
		nested: [{ text: "Nested" }],
		byId: { a: "Map" },
		pair: ["Pair", 1] as [string, number],
	};
	const raw: InferType<typeof schema> = data;
	const decoded = createCodec(schema).decode(createCodec(schema).encode(raw));
	const rawText: string = decoded.body;
	void rawText;
	const pulse = createPulse(definition, data);
	const body: RichText = pulse.body;
	void body;
	pulse.body.insert(5, "!");
	pulse.author.bio.format(0, 3, { bold: true });
	pulse.paragraphs[0]!.insert(0, "A");
	pulse.nested[0]!.text.delete(0, 1);
	pulse.optional?.toDelta();
	pulse.byId["a"]!.insert(0, "B");
	pulse.pair[0].format(0, 1, { italic: true });
	const pairLength: 2 = pulse.pair.length;
	void pairLength;
	createPulse(definition, {
		...data,
		body: richText("Marker"),
		paragraphs: [richText("P")],
	});
	// @ts-expect-error Inline rich text is a collaborative view, not a primitive string.
	const plain: string = pulse.body;
	void plain;
	// @ts-expect-error Mutation arguments remain typed.
	pulse.body.insert(0, 42);
	// @ts-expect-error Plain strings stay atomic.
	pulse.title.insert(0, "X");
	// @ts-expect-error The rich-text schema marker is not an initial value.
	createPulse(definition, { ...data, body: richText() });
	const { body: _body, ...withoutBody } = data;
	void _body;
	// @ts-expect-error A rich-text schema field is still required.
	createPulse(definition, withoutBody);
	// @ts-expect-error Undefined does not select either richText overload.
	richText(undefined);
	const snapshot = snapshotPulse(pulse);
	const snapshotBody: string = snapshot.body;
	const snapshotPair: [string, number] = snapshot.pair;
	void snapshotBody;
	void snapshotPair;
	// @ts-expect-error Snapshots expose text data, not collaborative methods.
	snapshot.nested[0]!.text.insert(0, "X");

	const first = definePulse("RichMigrationTypes", object({ body: richText() }));
	const nextSchema = object({
		body: richText(),
		paragraphs: array(richText()),
	});
	const migrated = first
		.migrateTo(nextSchema, (before) => {
			const text: string = before.body;
			// @ts-expect-error Migrations receive detached strings, not RichText proxies.
			before.body.text;
			return { body: text.toUpperCase(), paragraphs: [text] };
		})
		.migrateTo(nextSchema, (before) => {
			const text: string = before.paragraphs[0]!;
			return { body: text };
		})
		.materialize();
	createPulse(migrated, { body: "B", paragraphs: ["P"] }).body.insert(0, "A");

	type Legacy = PulseProperties<"LegacyRichMigrationTypes"> & {
		body: RichText;
	};
	definePulse<Legacy>("LegacyRichMigrationTypes")
		.migrate<Legacy>((before) => ({
			body: richText(before.body.toUpperCase()),
		}))
		.materialize();
}

/** Detached callback inputs must not turn unchanged public fields into changes. */
export function unchangedMigrationFieldTypeAssertions(): void {
	const empty: PulseSnapshot<Tuple<[]>> = [];
	const exactEmpty: [] = empty;
	const nested: PulseSnapshot<Tuple<[string, { body: RichText }]>> = [
		"A",
		{ body: "B" },
	];
	const exactNested: [string, { body: string }] = nested;
	const optional: PulseSnapshot<Tuple<[string, number?]>> = ["A"];
	const exactOptional: [string, number?] = optional;
	void exactEmpty;
	void exactNested;
	void exactOptional;
	// @ts-expect-error Tuple snapshot positions retain the detached field type.
	nested[1].body = 42;
	type V1 = PulseProperties<"UnchangedMigrationFields"> & {
		body: RichText;
		metadata: Struct<{ key: string }>;
		pair: Tuple<[string, number]>;
	};
	type V2 = V1 & { count: number };
	const builder = definePulse<V1>("UnchangedMigrationFields");
	const definition = builder
		.migrate<V2>((before) => {
			const body: string = before.body;
			const key: string = before.metadata.key;
			const pair: [string, number] = before.pair;
			void body;
			void key;
			void pair;
			// @ts-expect-error The callback receives plain text even when the public field is RichText.
			before.body.text;
			return { count: 0 };
		})
		.materialize();
	const pulse = createPulse(definition, {
		body: richText("Hello"),
		metadata: struct({ key: "K" }),
		pair: constantTuple(["A", 1]),
		count: 0,
	});
	pulse.body.insert(0, "A");
	// @ts-expect-error Retained constant fields stay readonly in the public model.
	pulse.metadata.key = "other";
	// @ts-expect-error Newly introduced required fields must still be returned.
	builder.migrate<V2>(() => ({}));
}
