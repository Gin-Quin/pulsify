# pulsify-prosemirror

Use the `pulsify-prosemirror` package to bind an existing
ProseMirror `EditorView` to a `richText()` field. Install `prosemirror-model`,
`prosemirror-state`, `prosemirror-transform` and `prosemirror-view` in the editor
application. They are peers of this package. `@pulsify/core` has no editor dependencies.
Install the binding and ProseMirror packages:

```sh
npm install @pulsify/core pulsify-prosemirror prosemirror-model prosemirror-state prosemirror-transform prosemirror-view
```

This example also uses `prosemirror-schema-basic` and `prosemirror-history`:

```ts
import { createPulse, definePulse, object, richText } from "@pulsify/core";
import { bindProseMirror, proseMirrorDocument } from "pulsify-prosemirror";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { schema } from "prosemirror-schema-basic";
import { history } from "prosemirror-history";

const Note = definePulse("Note", object({ body: richText() })).materialize();
const note = createPulse(Note, { body: "Bonjour" });
const view = new EditorView(document.querySelector("#editor"), {
  state: EditorState.create({ schema, plugins: [history()] }),
});
const binding = bindProseMirror(view, note.body);

// Normal editor transactions update the field and synchronize through Pulsify.
view.dispatch(view.state.tr.addMark(1, 8, schema.marks.strong!.create()));
console.log(proseMirrorDocument(note.body, schema).toJSON());

// On unmount: either detach the binding or destroy the editor (which detaches).
binding.destroy();
view.destroy();
```

The field supplies the initial editor document. A plain string is imported into
the schema's default text block. The first binding adds structural anchors once;
subsequent bindings restore paragraphs, nested lists, custom nodes, node
attributes and marks from the field. Existing editor plugins, custom node views
and `dispatchTransaction` remain in place. A custom dispatcher must apply
transactions synchronously and retain their document. Use the same ProseMirror
document schema on every peer; incompatible schemas are rejected.

Text edits use native character IDs, formatting uses native attribute registers,
and structure uses hidden node anchors. Concurrent first bindings share stable
anchors. Per-attribute conflicts follow Pulsify's deterministic last-writer order.
Deleted blocks hide their descendants; joining blocks redirects concurrent
insertions into the surviving block. Required empty blocks/wrappers are repaired
using the ProseMirror schema. Remote changes bypass the local undo history and
selections track surviving character/node IDs, including UTF-16 positions.
Use regular ProseMirror transactions for structure and formatting. Do not also
install ProseMirror's centralized collaboration plugin for the same document.

`field.text`, JSON output and `snapshotPulse` remain plain text, concatenating
text blocks without separators and omitting structural anchors. They are a text
projection, not a full editor document. Read nodes and marks with
`proseMirrorDocument(field, schema)` or `view.state.doc`. Pulsify's update frames
carry the full collaborative document. The `$pulsify:pm:` attribute prefix is
reserved for this binding.

Replacing/removing a bound field invalidates its old view. Detach and bind the
new field; create a fresh `EditorState` when switching documents to separate
their undo histories. `onError` can surface asynchronous synchronization errors:

```ts
const binding = bindProseMirror(view, note.body, {
  onError: error => console.error("Editor disconnected from the field", error),
});
```

Without `onError`, these errors reach the pulse's error handler. An invalid local
transaction is rejected and the editor returns to its previous state. A runnable
two-tab demo with formatting, lists, undo and offline reconnection is available
at `/prosemirror` after `bun run dev` from this repository.

Each document is marked as ProseMirror content. Binding a Lexical document
fails before changing it. The shared `richText()` schema does not imply automatic
conversion between editor document models.
