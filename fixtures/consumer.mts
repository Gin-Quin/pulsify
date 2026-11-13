import {
  connectPulse, createMemoryConnector, createPulse, createPulseScope, definePulse,
  destroyPulse, loadPulse, snapshotPulse, arrayOperations, exportPulseUpdates, applyPulseUpdates, getPulseVersions, recoverPulseHistory, SUPPORTED_PROTOCOL_VERSIONS, MigrationDriftError, richText, type RichText, type RichTextSchema, type MigrationDriftDetails, type PulseProperties,
} from "pulsify-core";
import { decodeMessage, encodeMessage, type PulseMessage } from "pulsify-core/protocol";
import { tree, type Tree, type TreeSchema } from "pulsify-core";
import { bindProseMirror, proseMirrorDocument, type ProseMirrorBinding } from "pulsify-prosemirror";
import type { EditorView } from "prosemirror-view";
import type { Schema, Node as ProseMirrorNode } from "prosemirror-model";
import { bindLexical, lexicalDocument, type LexicalBinding } from "pulsify-lexical";
import type { LexicalEditor, SerializedEditorState } from "lexical";

function bindLexicalEditor(editor: LexicalEditor, field: RichText): LexicalBinding {
  const state: SerializedEditorState = lexicalDocument(field);
  void state;
  // @ts-expect-error Plain strings are not collaborative fields.
  bindLexical(editor, "text");
  return bindLexical(editor, field, {schemaId: "consumer:v1"});
}
void bindLexicalEditor;
import { bindCodeMirror, type CodeMirrorBinding } from "pulsify-codemirror";
import type { EditorView as CodeMirrorView } from "@codemirror/view";
import { plainText, type PlainText, type PlainTextSchema } from "pulsify-core";

function bindCodeMirrorEditor(view: CodeMirrorView, field: PlainText, rich: RichText): CodeMirrorBinding {
  // @ts-expect-error CodeMirror binds plain text, not rich text.
  bindCodeMirror(view, rich);
  // @ts-expect-error Plain text has no editor structure for Lexical.
  bindLexical(undefined as unknown as LexicalEditor, field);
  return bindCodeMirror(view, field);
}
void bindCodeMirrorEditor;

function bindEditor(view: EditorView, field: RichText, schema: Schema): ProseMirrorBinding {
  const doc: ProseMirrorNode = proseMirrorDocument(field, schema);
  void doc;
  // @ts-expect-error A plain string is not a collaborative field.
  bindProseMirror(view, "text");
  return bindProseMirror(view, field, { onError: error => console.error(error) });
}
void bindEditor;

type Doc = PulseProperties<"Consumer"> & { title: string; items: { value: number }[] };
const Doc = definePulse<Doc>("Consumer").materialize();
const connector = createMemoryConnector();
const first = createPulse(Doc, { title: "consumer", items: [{ value: 1 }] }, { scope: createPulseScope(), connectors: [connector] });
first.items[0]!.value = 2;
// @ts-expect-error Managed IDs are readonly in the installed declarations.
first.id = "other";
// @ts-expect-error Field types survive the installed declaration graph.
first.title = 42;
const snapshot = snapshotPulse(first);
// @ts-expect-error Detached snapshots have plain arrays, not pulse mutation helpers.
snapshot.items.replaceAll([]);
const message: PulseMessage = { kind: 1, docId: first.id, requestId: 1, vv: [] };
decodeMessage(encodeMessage(message));
await connectPulse(first).synced;
const second = await loadPulse(Doc, first.id, { scope: createPulseScope(), connectors: [connector], waitFor: "all" });
const title: string = second.title;
void title;
const frames: Uint8Array[] = exportPulseUpdates(first, [], {peerVersion:SUPPORTED_PROTOCOL_VERSIONS[1]});
applyPulseUpdates(second,frames);
const stateFrames: Uint8Array[] = exportPulseUpdates(first,[],{peerVersion:3,mode:"auto"});
const versions: {state:[number,number][];history:[number,number][]}=getPulseVersions(first);
void versions; void stateFrames; const recover: Promise<void>=recoverPulseHistory(first); await recover;
// @ts-expect-error Unsupported protocol versions are excluded from the public API.
exportPulseUpdates(first,[],{peerVersion:5});
destroyPulse(first); destroyPulse(second);

// The typed codec API and storage entry point also compile from the tarball.
import { object, array, optional, createCodec, tuple as codecTuple } from "@gin-quin/codec";
import { PostgresPatchStore, type PatchStore } from "pulsify-core/storage";
const Typed = definePulse("TypedConsumer", object({
  body: "string", origin: object({ name: "string" }), values: array("uint"),
}), { constantPaths: [["origin"]], richTextPaths: [["body"]] }).materialize();
const typed = createPulse(Typed, { body: "Hello", origin: { name: "import" }, values: [] }, { scope: createPulseScope() });
typed.body.insert(5,"!");
typed.values.push(1);
// @ts-expect-error Declared constants remain readonly in installed declarations.
typed.origin.name = "changed";
const typedSnapshot = snapshotPulse(typed);
const text: string = typedSnapshot.body;
void text;
const store: PatchStore = new PostgresPatchStore(async () => []);
void store;
destroyPulse(typed);

const TupleDocument = definePulse("TupleConsumer", object({
  pair: codecTuple("uint", "string"),
  nested: array(object({ values: array("uint") })),
})).materialize();
const tupleDocument = createPulse(TupleDocument, {
  pair: [1, "A"], nested: [{ values: [1, 2] }],
}, { scope: createPulseScope() });
tupleDocument.pair = [2, "B"];
tupleDocument.pair[0] = 3;
tupleDocument.pair[1] = "C";
tupleDocument.nested = [{ values: [] }];
arrayOperations(tupleDocument.pair).replaceAll([4, "D"]);
arrayOperations(tupleDocument.nested).insert(0, [{ values: [5] }]);
// @ts-expect-error Installed declarations preserve individual tuple positions.
tupleDocument.pair[0] = "wrong";
// @ts-expect-error Tuple replacements require the exact declared shape.
arrayOperations(tupleDocument.pair).replaceAll([4, "D", 5]);
const plainTuple: [number, string] = snapshotPulse(tupleDocument).pair;
void plainTuple;
destroyPulse(tupleDocument);

const migrationV1 = object({ title: "string", count: "string" });
const migrationV2 = object({ title: "string", count: "uint", published: "boolean" });
const migrationV3 = object({ heading: "string", count: "uint", published: "boolean" });
const Migrated = definePulse("MigratedConsumer", migrationV1)
  .migrateTo(migrationV2, before => ({ count: Number(before.count), published: false }))
  .migrateTo(migrationV3, before => {
    const count: number = before.count;
    return { heading: before.title, count };
  })
  .materialize();
const migrated = createPulse(Migrated, { heading: "Latest", count: 1, published: false }, { scope: createPulseScope() });
migrated.count = 2;
// @ts-expect-error Schema-first migration inference survives installed declarations.
migrated.count = "bad";
// @ts-expect-error New required fields cannot be omitted from a migration.
definePulse("MissingMigrationField", migrationV1).migrateTo(migrationV2, () => ({ count: 0 }));
destroyPulse(migrated);

const driftDetails: MigrationDriftDetails = {
  docId: "consumer", kind: "MigratedConsumer", version: 3,
  expected: Migrated.migrationChain?.schemaIds[2], received: "m3:00000000000000000000000000000000",
  reason: "Published migration history changed",
};
const drift = new MigrationDriftError(driftDetails);
const driftCode: string = drift.code;
void driftCode;

const inlineField: RichTextSchema = richText();
const inlineSchema = object({
  body: inlineField, nested: array(object({ text: richText() })),
  paragraphs: array(richText()), optional: optional(richText()),
});
const Inline = definePulse("InlineConsumer", inlineSchema).materialize();
const inline = createPulse(Inline, { body: "Hello", nested: [{ text: "Nested" }], paragraphs: ["First"] }, { scope: createPulseScope() });
const inlineBody: RichText = inline.body;
inlineBody.insert(5, "!");
inline.nested[0]!.text.format(0, 1, { bold: true });
inline.paragraphs.push(richText("Next"));
const inlineText: string = snapshotPulse(inline).body;
const codecText: string = createCodec(inlineSchema).decode(createCodec(inlineSchema).encode({ body: "Text", nested: [], paragraphs: [] })).body;
void inlineText; void codecText;
// @ts-expect-error Schema markers are not creation data.
createPulse(Inline, { body: richText(), nested: [], paragraphs: [] });

const plainField: PlainTextSchema = plainText();
const plainSchema = object({ body: plainField, lines: array(plainText()), note: optional(plainText()) });
const Plain = definePulse("PlainConsumer", plainSchema).materialize();
const plain = createPulse(Plain, { body: "Hello", lines: ["First"] }, { scope: createPulseScope() });
const plainBody: PlainText = plain.body;
plainBody.replace(0, 5, "Goodbye");
plain.body = plainText("Assigned");
plain.lines.push(plainText("Next"));
plain.note = plainText("Created");
const plainSnapshot: string = snapshotPulse(plain).body;
const plainCodec: string = createCodec(plainSchema).decode(createCodec(plainSchema).encode({ body: "Text", lines: [] })).body;
void plainSnapshot; void plainCodec;
// @ts-expect-error A field has one type for reads and writes: wrap the string.
plain.body = "Assigned";
// @ts-expect-error Plain text has no formatting.
plainBody.format(0, 1, { bold: true });
// @ts-expect-error Rich text is not plain text.
const notPlain: PlainText = inlineBody;
void notPlain;
const InlineMigrated = definePulse("InlineMigratedConsumer", object({ body: richText() }))
  .migrateTo(object({ body: richText(), count: "uint" }), before => {
    const text: string = before.body;
    // @ts-expect-error Migration input is detached text, not a RichText view.
    before.body.text;
    return { body: text.toUpperCase(), count: 0 };
  }).materialize();
createPulse(InlineMigrated, { body: "Text", count: 1 }, { scope: createPulseScope() }).body.insert(0, "A");
destroyPulse(inline);

type PreservedRich = PulseProperties<"PreservedRichConsumer"> & { body: RichText };
type PreservedRichV2 = PreservedRich & { count: number };
const PreservedRichBuilder = definePulse<PreservedRich>("PreservedRichConsumer");
const PreservedRichDefinition = PreservedRichBuilder.migrate<PreservedRichV2>(before => {
  const text: string = before.body;
  void text;
  return { count: 0 };
}).materialize();
const preservedRich = createPulse(PreservedRichDefinition, { body: richText("Preserved"), count: 0 }, { scope: createPulseScope() });
preservedRich.body.format(0, 1, { bold: true });
// @ts-expect-error New required fields remain mandatory when unchanged rich fields are omitted.
PreservedRichBuilder.migrate<PreservedRichV2>(() => ({}));
destroyPulse(preservedRich);

const treeField: TreeSchema<"string"> = tree("string");
const TreeConsumer = definePulse("TreeConsumer", object({
  outline: tree(object({ title: "string", body: richText(), nested: treeField })),
  items: array("uint"),
})).materialize();
const treeDoc = createPulse(TreeConsumer, { outline: {}, items: [1, 2] }, { scope: createPulseScope() });
const root = treeDoc.outline.createNode({ title: "Root", body: "text", nested: {} });
const nestedTree: Tree<string> = root.data.nested;
nestedTree.createNode("Nested");
root.data.body.insert(0, "!");
root.move();
arrayOperations(treeDoc.items).move(0, 1);
const treeText: string = snapshotPulse(treeDoc).outline[root.id]!.data.body;
void treeText;
// @ts-expect-error Tree element schemas survive packaged declaration inference.
treeDoc.outline.createNode({ title: 12, body: "text", nested: {} });
// @ts-expect-error Nested tree element types are preserved.
nestedTree.createNode(12);
destroyPulse(treeDoc);
