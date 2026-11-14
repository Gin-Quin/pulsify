# pulsify-codemirror

Use the `pulsify-codemirror` package to bind an existing CodeMirror 6
`EditorView` to a `plainText()` field. Install `@codemirror/state` and
`@codemirror/view` in the editor application. They are peers of this package.
`pulsify-core` has no editor dependencies.

```sh
npm install pulsify-core pulsify-codemirror @codemirror/state @codemirror/view
```

This example also uses `codemirror` for its basic setup:

```ts
import { createPulse, definePulse, object, plainText } from "pulsify-core";
import { bindCodeMirror } from "pulsify-codemirror";
import { EditorView, basicSetup } from "codemirror";

const File = definePulse("File", object({ code: plainText() })).materialize();
const file = createPulse(File, { code: "const answer = 42;\n" });
const view = new EditorView({
  extensions: [basicSetup],
  parent: document.querySelector("#editor")!,
});
const binding = bindCodeMirror(view, file.code);

// Normal editor transactions edit the field and synchronize through Pulsify.
view.dispatch({ changes: { from: 0, insert: "// Hello\n" } });
console.log(file.code.text);

// On unmount: detach the binding, then destroy the editor.
binding.destroy();
view.destroy();
```

The field supplies the editor document: binding replaces whatever the editor
contained. Each change of an editor transaction, including the several ranges
of multiple cursors, becomes one edit of the field. Edits made by other peers
reach the editor as transactions outside its undo history, so CodeMirror's own
`history()` undoes local edits only, and selections follow the text around them.
Existing extensions stay in place. `view.setState()` discards the binding along
with the rest of the editor configuration: bind again afterwards.

CodeMirror counts every line break as one `"\n"`. The binding rewrites `"\r\n"`
and `"\r"` in the field to `"\n"` when it meets them, so positions agree on every
peer. Editor positions and `plainText()` indices both count UTF-16 code units.

Remote changes are applied by comparing the editor document with the field,
which reads both in full on every change of the pulse. Do not also install
`@codemirror/collab` for the same document.

## Remote cursors

Pass `selection` to share your selection through presence and draw the caret
and selected range of every other peer in the same field:

```ts
const binding = bindCodeMirror(view, file.code, {
  selection: { name: "Ada", color: "#e5484d" },
});
```

`selection: true` shares it without a name; a peer without a color gets one from
its peer number, and `draw: false` shares yours without drawing the others. Your
main selection is shared while the editor has the focus and withdrawn on blur
and on `binding.destroy()`. Nothing is written to the document. Cursors need a
connector that relays presence.

Selections travel on the `RichTextSelection` channel as anchors of the field
(`file.code.anchorAt(index)`), like those of the ProseMirror and Lexical
bindings. A remote caret is a zero-width `<span data-peer="…">` widget with a
colored left border and a label when the peer has a name; a selected range is
a `<span data-peer-selection="…">` with a translucent background. A remote
cursor never changes the local selection and never enters the undo history.
