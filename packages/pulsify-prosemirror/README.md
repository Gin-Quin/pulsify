# pulsify-prosemirror

Use the `pulsify-prosemirror` package to bind an existing
ProseMirror `EditorView` to a `richText()` field. Install `prosemirror-model`,
`prosemirror-state`, `prosemirror-transform` and `prosemirror-view` in the editor
application. They are peers of this package. `pulsify-core` has no editor dependencies.
Install the binding and ProseMirror packages:

```sh
npm install pulsify-core pulsify-prosemirror prosemirror-model prosemirror-state prosemirror-transform prosemirror-view
```

This example also uses `prosemirror-schema-basic`:

```ts
import { createPulse, definePulse, object, richText } from "pulsify-core";
import { bindProseMirror, proseMirrorDocument } from "pulsify-prosemirror";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { schema } from "prosemirror-schema-basic";

const Note = definePulse("Note", object({ body: richText() })).materialize();
const note = createPulse(Note, { body: "Bonjour" });
const view = new EditorView(document.querySelector("#editor"), {
  state: EditorState.create({ schema }),
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
using the ProseMirror schema. Remote changes bypass the Pulsify undo history and
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

## Collaborative history

The binding installs a Pulsify history plugin automatically. It records only
this editor's local operations; undo and redo produce ordinary Pulsify updates
and reach other peers through the same connector. Text inserted by another
editor and formatting it owns are preserved. Undoing the creation of a block
hides its descendants, including remote text inside that block.

Both editor packages export the same `createPulsifyHistory` factory. Pass a
plugin explicitly to configure it and connect toolbar buttons:

```ts
import { bindProseMirror, createPulsifyHistory, undo, redo } from "pulsify-prosemirror";
import { keymap } from "prosemirror-keymap";

const history = createPulsifyHistory({ undoDelay: 300, maxUndo: 100 });
const view = new EditorView(document.querySelector("#editor"), {
  state: EditorState.create({ schema, plugins: [keymap({
    "Mod-z": undo, "Mod-Shift-z": redo, "Mod-y": redo,
  })] }),
});
const binding = bindProseMirror(view, note.body, { history });

history.undo(); // boolean: whether a group was consumed
history.redo();
const unsubscribe = history.subscribe(() => {
  undoButton.disabled = !history.canUndo;
  redoButton.disabled = !history.canRedo;
});
history.stopCapturing(); // The next edit starts a new group.
history.clear();         // Clear both stacks without changing the document.
unsubscribe();
```

`binding.history` exposes the plugin, and `binding.undo()`, `binding.redo()`,
`binding.canUndo` and `binding.canRedo` are shortcuts. The exported ProseMirror
commands support availability checks without dispatch. Use these commands in
place of `prosemirror-history` and remove its `history()` plugin; Pulsify does
not install keyboard shortcuts for you.

Adjacent character insertions or deletions group within `undoDelay` milliseconds
(default 300). Other edits start a group. Remote document changes, selection-only
transactions and `stopCapturing()` end a group. Set transaction metadata
`pulsifyHistory` to `"push"` to force a group or `"merge"` to merge with the
previous group while capture is open. `addToHistory: false` synchronizes a
transaction without recording it; it ends grouping and clears redo.

`maxUndo` defaults to 100 groups; zero disables capture. The same `undoDelay`
and `maxUndo` options can be passed directly to `bindProseMirror` when no plugin
is supplied. One plugin connects to one editor at a time. Its stacks live in
memory, are not shared with peers and are cleared on binding destruction.
The plugin can then be connected again with empty stacks. Each editor needs its
own instance, even when two editors bind the same field.

## Remote cursors and anchors

Pass `selection` to share your selection through presence and draw the caret and
selected range of every other peer in the same field:

```ts
const binding = bindProseMirror(view, note.body, {
  selection: { name: "Ada", color: "#e5484d" },
});
```

`selection: true` shares it without a name; a peer without a color gets one from
its peer number. Your selection is shared while the editor has the focus and
withdrawn on blur, on `binding.destroy()` and on `view.destroy()`. Nothing is
written to the document. Cursors need a connector that relays presence.

Each remote caret is a widget decoration, a zero-width `<span data-peer="…">`
with a colored left border and a label when the peer has a name. A selected range
is an inline decoration, a `<span data-peer-selection="…">` with a translucent
background. Both use inline styles only. A remote cursor never changes the local
selection or the scroll position and never enters the undo history.

An anchor is a document position as a string. It follows its character through
local and remote edits, and resolves to where that character was once it is
deleted:

```ts
const anchor = binding.anchorAt(view.state.selection.head);
binding.positionOf(anchor); // a position, or undefined
```

`anchorAt` names the entry before the position, so text another peer inserts
exactly there lands after the anchor. A position between two blocks gives the
anchor of the end of the block before it. It throws a `RangeError` outside the
document. `positionOf` returns `undefined` for an anchor of another field or of a
character this peer has not received yet. Anchors are the same strings as
`field.anchorAt(index)` and `field.indexOf(anchor)`, which count text indices.
After `destroy()`, `anchorAt` throws and `positionOf` returns `undefined`.

To draw the other peers yourself, pass `draw: false` and read the
`RichTextSelection` presence channel:

```ts
import { joinPresence, RichTextSelection } from "pulsify-core";

const binding = bindProseMirror(view, note.body, {
  selection: { name: "Ada", draw: false },
});
const selections = joinPresence(note, RichTextSelection);
for (const { peer, state } of selections.others) {
  const position = binding.positionOf(state.head); // undefined: another field
}
```

Each document is marked as ProseMirror content. Binding a Lexical document
fails before changing it. The shared `richText()` schema does not imply automatic
conversion between editor document models.
