import { Seo } from "~/components/Seo";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";
import { Tabs } from "~/components/Tabs";

const schema = `import { definePulse, object, richText } from "pulsify-core";

export const Note = definePulse("Note", object({
  title: "string",
  body: richText(),
})).materialize();`;

const prosemirror = `// bun add pulsify-prosemirror prosemirror-model prosemirror-state prosemirror-transform prosemirror-view
import { bindProseMirror, proseMirrorDocument, undo, redo } from "pulsify-prosemirror";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { schema } from "prosemirror-schema-basic";
import { keymap } from "prosemirror-keymap";

const view = new EditorView(document.querySelector("#editor"), {
  state: EditorState.create({ schema, plugins: [keymap({
    "Mod-z": undo, "Mod-Shift-z": redo, "Mod-y": redo,
  })] }),
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

const history = `// The same factory is exported by pulsify-lexical.
import { createPulsifyHistory } from "pulsify-prosemirror";

const history = createPulsifyHistory({ undoDelay: 300, maxUndo: 100 });
const binding = bindProseMirror(view, note.body, { history });
// Or: bindLexical(editor, note.body, { history });
// Create a separate plugin for each editor.

history.undo(); history.redo(); // return whether a group was consumed
history.stopCapturing();       // next edit starts a group
const unsubscribe = history.subscribe(() => {
  undoButton.disabled = !history.canUndo;
  redoButton.disabled = !history.canRedo;
});
history.clear();               // clear stacks, keep the document
unsubscribe();`;

const cursorsProsemirror = `const binding = bindProseMirror(view, note.body, {
  // Share my selection and draw the others, each with its name and color.
  selection: { name: "Ada", color: "#e5484d" },
});`;

const cursorsLexical = `const binding = bindLexical(editor, note.body, {
  // Share my selection and draw the others, each with its name and color.
  selection: { name: "Ada", color: "#e5484d" },
});`;

const anchorsProsemirror = `// Note also has comments: array(object({ from: "string", to: "string", text: "string" })).
// A ProseMirror position, as a string that survives every edit.
const { from, to } = view.state.selection;
const range = { from: binding.anchorAt(from), to: binding.anchorAt(to) };

// An anchor is plain data: store it in the pulse to pin a comment.
note.comments.push({ ...range, text: "Typo?" });

// Later, on any peer, after any number of edits:
binding.positionOf(comment.from); // a position, or undefined`;

const anchorsLexical = `import { $getSelection, $isRangeSelection } from "lexical";

// Note also has comments: array(object({ from: "string", to: "string", text: "string" })).
// A Lexical point, as a string that survives every edit.
const range = editor.read(() => {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return;
  return { from: binding.anchorAt(selection.anchor), to: binding.anchorAt(selection.focus) };
});

// An anchor is plain data: store it in the pulse to pin a comment.
if (range) note.comments.push({ ...range, text: "Typo?" });

// Later, on any peer, after any number of edits:
binding.pointOf(comment.from); // { key, offset, type }, or undefined`;

const custom = `import { joinPresence, RichTextSelection } from "pulsify-core";

const binding = bindProseMirror(view, note.body, {
  selection: { name: "Ada", color: "#e5484d", draw: false }, // share mine, draw nothing
});

// { anchor, head, name, color } for each peer with a selection in this pulse.
const selections = joinPresence(note, RichTextSelection);

// Call it after a change of the selections and after a change of the document.
function avatars() {
  return selections.others.flatMap(({ peer, state }) => {
    const position = binding.positionOf(state.head); // undefined: another field, or not here yet
    return position === undefined ? [] : [{ peer, ...state, top: view.coordsAtPos(position).top }];
  });
}`;

const codemirror = `// bun add pulsify-codemirror @codemirror/state @codemirror/view
import { definePulse, object, plainText } from "pulsify-core";
import { bindCodeMirror } from "pulsify-codemirror";
import { EditorView, basicSetup } from "codemirror";

const File = definePulse("File", object({
  code: plainText(),
})).materialize();

const view = new EditorView({ extensions: [basicSetup], parent });
const binding = bindCodeMirror(view, file.code);

// On unmount.
binding.destroy();
view.destroy();`;

export default function Editors() {
	return (
		<>
			<Seo
				title="Rich text editors · Pulsify Docs"
				description="Bind ProseMirror, Lexical or a code editor to a collaborative text field, with shared undo history, remote cursors and anchors."
			/>
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
					{
						label: "ProseMirror",
						content: <CodeBlock title="editor.ts" code={prosemirror} />,
					},
					{
						label: "Lexical",
						content: <CodeBlock title="editor.ts" code={lexical} />,
					},
				]}
			/>

			<h2>Collaborative history</h2>
			<p>
				Both bindings install the same Pulsify history plugin automatically. It
				records only the bound editor's local operations. Undo and redo produce
				ordinary Pulsify updates that synchronize with other peers, preserving
				their text and formatting. Pass a plugin explicitly to configure
				grouping and connect your toolbar:
			</p>
			<CodeBlock title="history.ts" code={history} />
			<p>
				<code>binding.history</code> exposes the plugin. Both bindings also
				provide <code>undo()</code>, <code>redo()</code>, <code>canUndo</code>
				and <code>canRedo</code> directly. A plugin connects to one editor at a
				time. Its stacks stay in memory, are not shared or restored on reload,
				and are cleared when the binding is destroyed.
			</p>
			<ul>
				<li>
					Adjacent character insertions or deletions group for 300 ms by
					default. Other edits and remote document changes end grouping.
					<code>undoDelay</code> sets the interval; <code>maxUndo</code> limits
					groups (default 100, zero disables capture). Both options can also be
					passed directly to either binding when no plugin is supplied.
				</li>
				<li>
					ProseMirror uses the <code>undo</code> and <code>redo</code> commands
					from <code>pulsify-prosemirror</code> in keymaps. Replace
					<code>prosemirror-history</code> and its <code>history()</code>{" "}
					plugin. A transaction with <code>addToHistory: false</code>{" "}
					synchronizes without being recorded. Metadata{" "}
					<code>pulsifyHistory</code> accepts
					<code>"push"</code> or <code>"merge"</code> to control grouping.
				</li>
				<li>
					Lexical connects <code>UNDO_COMMAND</code>, <code>REDO_COMMAND</code>
					and <code>CLEAR_HISTORY_COMMAND</code> automatically and reports
					availability through <code>CAN_UNDO_COMMAND</code> and
					<code>CAN_REDO_COMMAND</code>. It honors <code>HISTORY_PUSH_TAG</code>
					and <code>HISTORY_MERGE_TAG</code>; do not add
					<code>@lexical/history</code> or React's HistoryPlugin.
				</li>
				<li>
					A new local edit clears redo; remote changes preserve it. Undoing a
					block's creation hides that block's descendants, including remote text
					inside it. Undo restores deleted characters with fresh IDs and keeps
					older history groups connected to them.
				</li>
			</ul>

			<h2>Remote cursors</h2>
			<p>
				Pass <code>selection</code> and the binding shares your selection
				through <a href="/docs/presence">presence</a> and draws the caret and
				the selected range of every other peer in the same field. Nothing is
				stored, and a peer that leaves takes its cursor with it.
			</p>
			<Tabs
				tabs={[
					{
						label: "ProseMirror",
						content: <CodeBlock title="editor.ts" code={cursorsProsemirror} />,
					},
					{
						label: "Lexical",
						content: <CodeBlock title="editor.ts" code={cursorsLexical} />,
					},
				]}
			/>
			<ul>
				<li>
					<code>selection: true</code> shares it without a name; each peer then
					gets a color from its peer number.
				</li>
				<li>
					Cursors need a connector that relays presence.{" "}
					<a href="/docs/presence#where-it-works">Where it works →</a>
				</li>
				<li>
					A remote cursor never moves the local selection or the scroll
					position, and never enters the undo history.
				</li>
				<li>
					Sharing and drawing write nothing to the document, so a reader shows
					cursors too. The first binding of a field does write its structure:
					let an editor bind a new field before a reader does.
				</li>
				<li>
					ProseMirror draws with decorations. Lexical has none, so the binding
					draws in an overlay inside the editor's parent: give that parent{" "}
					<code>position: relative</code>, or pass another{" "}
					<code>container</code>.
				</li>
			</ul>

			<h2>Anchors</h2>
			<p>
				A remote cursor is built on one primitive, which you can use for
				anything that must stay attached to a place in the text: comments,
				bookmarks, a peer's avatar in the margin. An anchor is a string that
				follows its character through local and remote edits, and resolves to
				where that character was once it is deleted.
			</p>
			<Tabs
				tabs={[
					{
						label: "ProseMirror",
						content: <CodeBlock title="anchors.ts" code={anchorsProsemirror} />,
					},
					{
						label: "Lexical",
						content: <CodeBlock title="anchors.ts" code={anchorsLexical} />,
					},
				]}
			/>
			<ul>
				<li>
					<strong>An anchor stays after what precedes it</strong>: a character,
					the start of a paragraph, or the start of the field. Text typed
					exactly there by someone else lands after the anchor.
				</li>
				<li>
					<strong>Once its character is deleted</strong>, an anchor stays where
					the character was. If an undo brings the character back, it comes back
					under a new identity, right after the anchor.
				</li>
				<li>
					<strong>It names its field.</strong> Resolving it in another field
					returns <code>undefined</code>, and so does a field that was replaced.
				</li>
				<li>
					<strong>Presence can arrive before the text it points into.</strong>{" "}
					Resolving returns <code>undefined</code> until the character is there,
					so resolve again after the document changes. The bindings do it for
					the cursors they draw, and meanwhile keep a peer's cursor where it
					was, for up to 1.5 seconds.
				</li>
				<li>
					Without an editor, a field has the same pair in text indices, which
					count Unicode code points: <code>field.anchorAt(index)</code> and{" "}
					<code>field.indexOf(anchor)</code>.
				</li>
			</ul>
			<p>
				To draw the others yourself, keep the sharing and turn the drawing off.
				The selections are an ordinary presence channel,{" "}
				<code>RichTextSelection</code>, whose anchors you resolve with the
				binding:
			</p>
			<CodeBlock title="avatars.ts" code={custom} />

			<h2>Code editors</h2>
			<p>
				Code is plain text: highlighting belongs to the editor. Bind CodeMirror
				to a <code>plainText()</code> field. The field supplies the document,
				editor changes edit the field, and changes from other peers stay out of
				the undo history, so CodeMirror's own <code>history()</code> undoes
				local edits only.
			</p>
			<CodeBlock title="editor.ts" code={codemirror} />

			<h2>Rules of the road</h2>
			<ul>
				<li>
					Use Pulsify's history plugin for undo and redo in both editors. Do not
					add another collaboration binding to the same editor.
				</li>
				<li>
					Use the same editor schema and registered node classes on every peer.
				</li>
				<li>
					<code>field.text</code> and snapshots are a plain-text projection.
					Read nodes with <code>proseMirrorDocument</code> or{" "}
					<code>lexicalDocument</code>.
				</li>
				<li>
					Always call <code>binding.destroy()</code> on unmount. Switching
					documents needs a fresh editor state.
				</li>
			</ul>

			<Note>
				Fields nested in objects and arrays bind the same way:{" "}
				<code>bindLexical(editor, doc.comments[0].text)</code>.
			</Note>
		</>
	);
}
