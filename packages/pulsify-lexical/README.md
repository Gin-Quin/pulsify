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

The binding provides collaborative undo/redo through Lexical's `UNDO_COMMAND`
and `REDO_COMMAND`, or `binding.undo()` / `binding.redo()`. `binding.canUndo` and
`binding.canRedo` expose availability. It inverts local character/attribute
operations against the current document, preserving remote edits. Do not also
install `@lexical/history`, its React history plugin, or another collaboration
binding on the same editor. Deleted blocks hide their descendants; undoing a
block's creation can therefore hide remote edits inside that block too.

Selections follow character identities with UTF-16 offsets. Remote updates
retain editor node keys where possible. Pending batched local updates are
rebased against remote changes. Registered nodes must implement Lexical's JSON
import/update/export contract; slot-based nested editors (`$slots`) currently
require a dedicated mapping and are rejected explicitly.

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
