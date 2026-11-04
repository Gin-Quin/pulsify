import {
	array,
	literal,
	object,
	optional,
	tuple,
	union,
} from "@gin-quin/codec";
import { createPulse } from "../source/pulses/createPulse.js";
import { definePulse } from "../source/pulses/PulseDefinition.js";
import { createPulseScope } from "../source/pulses/PulseOptions.js";
import { richText } from "../source/core/richText.js";
import { arrayOperations } from "../source/pulses/PulseArray.js";
import { snapshotPulse } from "../source/pulses/Pulse.js";
import { Buffer } from "node:buffer";
import type { PulseProperties } from "../source/pulses/PulseProperties.js";

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
