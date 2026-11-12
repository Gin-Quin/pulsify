# pulsify-lexical

Bind a Lexical editor to a Pulsify `richText()` field. Works with vanilla
JavaScript, React integrations and headless Lexical editors. React is not a
dependency, and neither this package nor the core depends on ProseMirror.

```sh
npm install pulsify-core pulsify-lexical lexical
```

For the browser example below, also install `@lexical/rich-text`. Keep all your
Lexical packages on the same version (this binding supports Lexical 0.53.x).

```ts
import { createPulse, definePulse, object, richText } from "pulsify-core";
import { bindLexical, lexicalDocument } from "pulsify-lexical";
import { createEditor } from "lexical";
import { registerRichText } from "@lexical/rich-text";

const Note = definePulse("Note", object({ body: richText() })).materialize();
const note = createPulse(Note, { body: "Bonjour" });
const editor = createEditor({
  namespace: "Notes",
  onError: error => console.error(error),
});
editor.setRootElement(document.querySelector("#editor"));
const unregisterRichText = registerRichText(editor);
const binding = bindLexical(editor, note.body);

// Nodes and formatting as Lexical's serialized editor state.
console.log(lexicalDocument(note.body));

// On unmount, explicitly release listeners and command handlers.
binding.destroy();
unregisterRichText();
editor.setRootElement(null);
```

Mount the editor on a contenteditable element:

```html
<div id="editor" contenteditable="true" role="textbox"
     aria-multiline="true" style="white-space: pre-wrap"></div>
```

The field supplies the initial document. Its initial plain string becomes a
paragraph; subsequent bindings restore the full document. Text, formatting,
links, headings, lists, registered custom element/text/decorator nodes and their
serialized properties travel through native Pulsify operations. Text format
bits merge independently. Each document records its editor family, so binding
a ProseMirror document fails before changing it. The binding does not convert
between editor families.

Register the node classes used by the document on every editor. A `schemaId`
option can identify your application document model; bump it when custom node
semantics change and use the same value on all peers:

```ts
const binding = bindLexical(editor, note.body, {
  schemaId: "notes:v1", // Defaults to "lexical:1".
  undoDelay: 300,        // Group adjacent typing within this many milliseconds.
  maxUndo: 100,          // Maximum local undo groups.
  onError: error => console.error("Editor disconnected", error),
});
```

## Collaborative history

The binding installs the same Pulsify history plugin as `pulsify-prosemirror`.
It records only this editor's local operations. Undo/redo invert character and
attribute operations against the current document and synchronize through the
normal Pulsify connector, preserving remote edits. Do not also install
`@lexical/history`, its React history plugin, or another collaboration binding
on the same editor. Undoing a block's creation hides its descendants, including
remote text inside that block.

```ts
import { bindLexical, createPulsifyHistory } from "pulsify-lexical";

const history = createPulsifyHistory({ undoDelay: 300, maxUndo: 100 });
const binding = bindLexical(editor, note.body, { history });

history.undo();
history.redo();
const unsubscribe = history.subscribe(() => {
  undoButton.disabled = !history.canUndo;
  redoButton.disabled = !history.canRedo;
});
history.stopCapturing(); // The next edit starts a new group.
history.clear();         // Clear both stacks without changing the document.
unsubscribe();
```

`binding.history` exposes the plugin; `binding.undo()` / `binding.redo()` and
`binding.canUndo` / `binding.canRedo` are shortcuts. Lexical's `UNDO_COMMAND`,
`REDO_COMMAND` and `CLEAR_HISTORY_COMMAND` connect to it automatically.
`CAN_UNDO_COMMAND` and `CAN_REDO_COMMAND` report availability after local edits,
undo, redo and clear. Direct `history.undo()` / `redo()` calls flush pending
batched editor updates first.

Adjacent character insertions or deletions group within `undoDelay` milliseconds
(default 300). Other edits, remote document changes and `stopCapturing()` end
a group. Lexical's `HISTORY_PUSH_TAG` forces a new group; `HISTORY_MERGE_TAG`
merges with the previous group while capture is open. A new local edit clears
redo; remote changes preserve it.

`maxUndo` defaults to 100 groups; zero disables capture. The original binding
options `undoDelay` and `maxUndo` remain supported when no plugin is supplied.
One plugin connects to one editor at a time. Its stacks live in memory, are not
shared with peers and are cleared by `binding.destroy()`. The plugin can then
be connected again with empty stacks. Each editor needs its own instance, even
when two editors bind the same field.

Selections follow character identities with UTF-16 offsets. Remote updates
retain editor node keys where possible. Pending batched local updates are
rebased against remote changes. Registered nodes must implement Lexical's JSON
import/update/export contract; slot-based nested editors (`$slots`) currently
require a dedicated mapping and are rejected explicitly.

## Remote cursors and anchors

Pass `selection` to share your selection and draw the others:

```ts
const binding = bindLexical(editor, note.body, {
  selection: { name: "Ada", color: "#e5484d" },
});
```

The binding publishes the range selection in the pulse's `RichTextSelection`
presence channel. It removes it when the selection becomes null, when the
editor loses focus (until it is focused again), and when the binding is
destroyed. Nothing is written to the
document and no undo step is created. `selection: true` shares without a name;
a peer without a color gets one from its peer number. Cursors need a connector
that relays presence.

Lexical has no decorations, so the caret and the selected range of each other
peer are absolutely positioned elements, in a layer appended to the parent of
the root element or to `selection.container`. Give that element
`position: relative`. A caret carries `data-peer`, each rectangle of a range
`data-peer-selection`. Styles are inline and nothing takes pointer events. The
layer is redrawn after presence changes, editor updates, scrolls and resizes of
the root element, and removed by `binding.destroy()`. A headless editor shares
its selection and draws nothing.

An anchor is a string that follows a place in the text through local and remote
edits:

```ts
import { $getSelection, $isRangeSelection } from "lexical";

const anchor = editor.read(() => {
  const selection = $getSelection();
  return $isRangeSelection(selection) ? binding.anchorAt(selection.anchor) : undefined;
});

binding.pointOf(anchor); // { key, offset, type }, or undefined
```

`anchorAt` takes a point of the current editor state: `{ key, offset }`, with
an optional `type` that defaults to what the node is. It throws a `RangeError`
for a point outside the document. An anchor names the character or node just
before the point, so text typed exactly there lands after it. Once that
character is deleted, the anchor resolves to where it was. `pointOf` returns
`undefined` for an anchor of another field, or of a character this peer has not
received yet. Anchors are plain data and the same as `field.anchorAt(index)`
and `field.indexOf(anchor)`: store them in a pulse to pin a comment.

To draw the others yourself, pass `selection: { draw: false }`, read
`joinPresence(note, RichTextSelection).others` and resolve each `state.anchor`
and `state.head` with `binding.pointOf`.

`field.text`, `toJSON()` and `snapshotPulse` remain plain text, concatenating text
blocks without separators. They are projections, not complete editor documents.
Read full nodes and formatting with `lexicalDocument(field)` or
`editor.getEditorState().toJSON()`. Pulsify update frames carry the collaborative
history. The binding also works with fields nested in objects and arrays.

Replacing/removing a bound field disconnects the old binding and calls
`onError`, or the pulse's error handler when no callback is provided. Bind the
new field explicitly. Always call `binding.destroy()` when unmounting; detaching
Lexical's root alone does not release the field subscription. Local validation
failures restore the previous editor state without committing a partial edit.

Run `bun run dev` in this repository and open `/lexical` in two tabs for a
vanilla JavaScript demo with formatting, lists, undo and offline reconnection.
