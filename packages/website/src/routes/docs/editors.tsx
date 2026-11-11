import { Title } from "@solidjs/meta";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";
import { Tabs } from "~/components/Tabs";

const schema = `import { definePulse, object, richText } from "@pulsify/core";

export const Note = definePulse("Note", object({
  title: "string",
  body: richText(),
})).materialize();`;

const prosemirror = `// bun add pulsify-prosemirror prosemirror-model prosemirror-state prosemirror-transform prosemirror-view
import { bindProseMirror, proseMirrorDocument } from "pulsify-prosemirror";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { schema } from "prosemirror-schema-basic";
import { history } from "prosemirror-history";

const view = new EditorView(document.querySelector("#editor"), {
  state: EditorState.create({ schema, plugins: [history()] }),
});
const binding = bindProseMirror(view, note.body, {
  onError: (error) => console.error(error),
});

// Regular transactions flow into the field and to every peer.
view.dispatch(view.state.tr.insertText("Hi"));
proseMirrorDocument(note.body, schema); // full node tree with marks

// On unmount:
binding.destroy();
view.destroy();`;

const lexical = `// bun add pulsify-lexical lexical @lexical/rich-text
import { bindLexical, lexicalDocument } from "pulsify-lexical";
import { createEditor } from "lexical";
import { registerRichText } from "@lexical/rich-text";

const editor = createEditor({ namespace: "Notes", onError: console.error });
editor.setRootElement(document.querySelector("#editor"));
const unregister = registerRichText(editor);

const binding = bindLexical(editor, note.body, {
  schemaId: "notes:v1", // bump when custom node semantics change
  undoDelay: 300,
  onError: (error) => console.error(error),
});

binding.undo(); binding.redo(); // collaborative undo, remote edits preserved
lexicalDocument(note.body);     // serialized editor state

// On unmount:
binding.destroy();
unregister();
editor.setRootElement(null);`;

export default function Editors() {
	return (
		<>
			<Title>Rich text editors · Docs</Title>
			<h1>Rich text editors</h1>
			<p>
				Bind an existing editor to a <code>richText()</code> field. Text uses
				native character operations, formatting uses attribute registers,
				structure uses hidden anchors. The core has no editor dependency.
			</p>

			<h2>The field</h2>
			<CodeBlock title="note.ts" code={schema} />
			<p>
				The field supplies the initial document. A plain string becomes a
				paragraph; later bindings restore the full structure. Each document
				records its editor family, so a Lexical binding on a ProseMirror
				document fails before changing anything.
			</p>

			<h2>Bind</h2>
			<Tabs
				tabs={[
					{ label: "ProseMirror", content: <CodeBlock title="editor.ts" code={prosemirror} /> },
					{ label: "Lexical", content: <CodeBlock title="editor.ts" code={lexical} /> },
				]}
			/>

			<h2>Rules of the road</h2>
			<ul>
				<li>Do not add the editor's own collaboration or history plugin to a bound editor. Lexical's binding provides undo and redo; ProseMirror keeps its local history plugin and remote changes bypass it.</li>
				<li>Use the same editor schema and registered node classes on every peer.</li>
				<li><code>field.text</code> and snapshots are a plain-text projection. Read nodes with <code>proseMirrorDocument</code> or <code>lexicalDocument</code>.</li>
				<li>Always call <code>binding.destroy()</code> on unmount. Switching documents needs a fresh editor state.</li>
			</ul>

			<Note>
				Fields nested in objects and arrays bind the same way:{" "}
				<code>bindLexical(editor, doc.comments[0].text)</code>.
			</Note>
		</>
	);
}
