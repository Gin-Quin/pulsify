import { array, literal, object, optional } from "@gin-quin/codec";
import {
	createPulse,
	definePulse,
	tree,
	snapshotPulse,
	richText,
} from "../source/index.js";

/** Compile-time assertions; deliberately not executed by the test runner. */
export function treeTypeAssertions(): void {
	const D = definePulse(
		"TreeTypes",
		object({
			nested: tree(tree("string")),
			objects: tree(
				object({ label: "string", nested: tree("uint"), body: richText() }),
			),
			optional: optional(tree("string")),
			arrays: array(tree("uint")),
		}),
	).materialize();
	const doc = createPulse(D, {
		nested: {},
		objects: {},
		optional: {},
		arrays: [{}],
	});
	const inner = doc.nested.createNode({});
	inner.data.createNode("name");
	inner.data = {};
	const item = doc.objects.createNode({
		label: "typed",
		nested: {},
		body: "text",
	});
	item.data.nested.createNode(12);
	item.data.body.insert(0, "!");
	item.data = { label: "next", nested: {}, body: "next" };
	doc.arrays[0]!.createNode(13);
	doc.optional!.createNode("optional");
	const snapshot = snapshotPulse(doc);
	const text: string = snapshot.objects[item.id]!.data.body;
	const name: string = inner.data.roots()[0]!.data;
	void [text, name];
	// @ts-expect-error Tree payload schemas reject the wrong scalar type.
	doc.nested.createNode({}).data.createNode(12);
	// @ts-expect-error Object payloads retain their typed required fields.
	doc.objects.createNode({ nested: {}, body: "text" });
	// @ts-expect-error Node data replacement retains payload typing.
	item.data = { label: 12, nested: {}, body: "text" };
	const Tagged = definePulse(
		"TaggedTreeTypes",
		object({
			outline: tree(
				object({
					kind: literal("folder"),
					config: literal({ count: 0 }),
					body: "string",
				}),
			),
		}),
		{
			richTextPaths: [["outline", "*", "data", "body"]],
		},
	).materialize();
	const tagged = createPulse(Tagged, { outline: {} });
	const folder = tagged.outline.createNode({
		kind: "folder",
		config: { count: 0 },
		body: "hello",
	});
	folder.data.body.insert(5, "!");
	folder.move();
	// @ts-expect-error Payload literals remain readonly inside the tree boundary.
	folder.data.kind = "folder";
	// @ts-expect-error Nested literal payloads remain deeply readonly.
	folder.data.config.count = 0;
}
