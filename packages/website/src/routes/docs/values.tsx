import { Seo } from "~/components/Seo";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";

const primitives = `import { definePulse, literal, object, optional, union } from "pulsify-core";

const Settings = definePulse("Settings", object({
  name: "string",          // atomic: replacing it is one write
  count: "int",            // also uint, int32, uint32, float32, float64
  big: "bigint",
  enabled: "boolean",
  updated: "date",
  avatar: "uint8Array",    // copied binary leaf
  nickname: optional("string"),
  theme: union([literal("light"), literal("dark")]),
})).materialize();

const s = createPulse(Settings, {
  name: "Ada", count: 1, big: 10n, enabled: true,
  updated: new Date(), avatar: new Uint8Array(), theme: "dark",
});
s.count += 1;
s.nickname = "ada";
s.nickname = undefined;`;

const objects = `const Profile = definePulse("Profile", object({
  address: object({ city: "string", zip: "string" }),
  prefs: map("boolean"),  // Record<string, boolean>
})).materialize();

const p = createPulse(Profile, { address: { city: "Paris", zip: "75001" }, prefs: {} });
p.address.city = "Lyon";            // one field register, concurrent zip edits survive
p.address = { city: "Nice", zip: "06000" }; // replaces the whole container
p.prefs["dark"] = true;
delete p.prefs["dark"];`;

const arrays = `import { arrayOperations } from "pulsify-core";

const List = definePulse("List", object({
  items: array(object({ label: "string", done: "boolean" })),
})).materialize();

const list = createPulse(List, { items: [] });

// Everything a normal array does.
list.items.push({ label: "A", done: false }, { label: "B", done: false });
list.items[0]!.done = true;
list.items.splice(1, 1);
list.items.unshift({ label: "Z", done: false });
list.items.filter((item) => item.done).length;

// Plus explicit collection operations.
const ops = arrayOperations(list.items);
ops.insert(1, [{ label: "C", done: false }]);
ops.delete(0, 1);
ops.move(1, 0);       // [A, C] → [C, A], element identity preserved
ops.move(0, 2, 2);    // move a block of 2, \`to\` is its first final index
ops.replaceAll([{ label: "fresh", done: false }]);`;

const tuples = `const Geo = definePulse("Geo", object({
  point: tuple("float64", "float64"),
  labeled: tuple("string", "int", object({ ok: "boolean" })),
})).materialize();

const g = createPulse(Geo, { point: [48.85, 2.35], labeled: ["x", 1, { ok: true }] });
g.point[0] = 48.86;       // typed per slot
g.point.push(1);          // rejected: tuples keep their length`;

const unions = `const Event = definePulse("Event", object({
  payload: union({
    tagName: "kind",
    tagType: "string",
    variants: {
      created: { title: "string" },
      deleted: { reason: optional("string") },
    },
  }),
})).materialize();

const e = createPulse(Event, { payload: { kind: "created", title: "Hi" } });
if (e.payload.kind === "created") e.payload.title = "Hello"; // narrowed
e.payload = { kind: "deleted" };                              // switch variant`;

const plain = `import { plainText } from "pulsify-core";

const Note = definePulse("Note", object({
  title: "string",   // atomic: the last writer wins
  body: plainText(), // collaborative: edits merge
})).materialize();

const note = createPulse(Note, { title: "Note", body: "Hello" });
note.body.insert(5, " world");
note.body.replace(0, 5, "Goodbye"); // delete 5 code units, insert
note.body.text;       // "Goodbye world"
note.body.length;     // UTF-16 code units, like String

// Assigning edits only what changed, so a text area needs no binding.
textarea.addEventListener("input", () => {
  note.body = plainText(textarea.value);
});

// A position that follows its character while other peers type.
const caret = note.body.anchorAt(textarea.selectionStart);
note.body.indexOf(caret);`;

const rich = `import { richText } from "pulsify-core";

const Doc = definePulse("Doc", object({
  body: richText(),
  comments: array(object({ text: richText() })),
})).materialize();

const doc = createPulse(Doc, { body: "Hello", comments: [] });
doc.body.insert(5, " world");
doc.body.format(0, 5, { bold: true });
doc.body.delete(0, 1);
doc.body.text;        // "ello world"
doc.body.length;      // code points
doc.body.toDelta();   // [{ insert: "ello", attributes: { bold: true } }, { insert: " world" }]

doc.comments.push({ text: "First" }); // plain strings initialize rich text
doc.comments[0]!.text.insert(5, "!");`;

const trees = `import { tree } from "pulsify-core";

const Outline = definePulse("Outline", object({
  outline: tree(object({ title: "string", body: richText() })),
})).materialize();

const doc = createPulse(Outline, { outline: {} });
const chapter = doc.outline.createNode({ title: "Chapter", body: "" });
const section = chapter.createNode({ title: "Section", body: "Text" });
const appendix = doc.outline.createNode({ title: "Appendix", body: "" });

section.data.title = "Renamed";     // payload is a normal typed value
section.move(appendix, 0);          // reparent, keeps subtree and proxies
section.moveBefore(chapter);        // sibling moves adopt the parent
section.move();                     // back to the roots
appendix.delete();                  // hides the node and its descendants

doc.outline.roots();                // TreeNode[]
chapter.children();
doc.outline.getNode(section.id);
doc.outline.toJSON();               // { id, data, children }[]`;

export default function Values() {
	return (
		<>
			<Seo
				title="Values · Pulsify Docs"
				description="What a pulse can hold: primitives, objects, maps, arrays, tuples, unions, plain text, rich text and trees, and how each one merges."
			/>
			<h1>Values</h1>
			<p>
				Everything the codec can describe, Pulsify can synchronize. Fields are
				last-writer-wins registers, sequences are RGAs, and nested containers
				keep their identity across remote edits.
			</p>

			<h2>Primitives</h2>
			<CodeBlock title="settings.ts" code={primitives} />
			<p>
				Plain strings are atomic: assigning one replaces the whole value. Use{" "}
				<code>plainText()</code> or <code>richText()</code> for character-level
				collaboration. Float32 fields read back their normalized wire value.
			</p>

			<h2>Objects and maps</h2>
			<p>
				Each object field is its own register, so two peers editing different
				fields of the same object both win. Assigning a whole object replaces
				the container and invalidates references to the old one.
			</p>
			<CodeBlock title="profile.ts" code={objects} />

			<h2>Arrays</h2>
			<p>
				A pulse array <strong>is</strong> an array: same methods, same types,
				same iteration. <code>arrayOperations</code> adds what native arrays
				lack, most importantly <code>move</code>, which keeps element identity
				and merges with concurrent edits to the moved element.
			</p>
			<CodeBlock title="list.ts" code={arrays} />
			<ul>
				<li>Removal methods return detached values.</li>
				<li>
					Holes, extending <code>length</code> and <code>delete arr[i]</code>{" "}
					are rejected; use <code>splice</code>.
				</li>
				<li>
					<code>sort</code>, <code>reverse</code> and <code>replaceAll</code>{" "}
					rebuild elements. Prefer <code>move</code> for reordering.
				</li>
				<li>Deletion wins over any concurrent move of the same element.</li>
			</ul>

			<h2>Tuples</h2>
			<CodeBlock title="geo.ts" code={tuples} />

			<h2>Optionals and unions</h2>
			<p>
				<code>optional(schema)</code> allows <code>undefined</code>. Tagged
				unions narrow in TypeScript and switch variants by assignment.
			</p>
			<CodeBlock title="event.ts" code={unions} />

			<p>
				To restrict how a value can be written, see{" "}
				<a href="/docs/modifiers">value modifiers</a>: <code>constant</code>,{" "}
				<code>frozen</code> and friends.
			</p>

			<h2>Plain text</h2>
			<p>
				<code>plainText()</code> is a string whose concurrent edits merge: two
				peers typing in the same field, even offline, both keep their
				characters. It has no formatting. Indices count UTF-16 code units, and
				an emoji is never split.
			</p>
			<CodeBlock title="note.ts" code={plain} />
			<p>
				Assigning a string to the field compares it with the current text and
				edits the difference, instead of replacing the value. For a code editor,
				bind the field to <a href="/docs/editors">CodeMirror</a>.
			</p>

			<h2>Rich text</h2>
			<p>
				<code>richText()</code> is a string on the wire and a collaborative text
				in memory. Indices count Unicode code points. Formatting is per
				character; concurrent edits to different attributes merge.
			</p>
			<CodeBlock title="doc.ts" code={rich} />
			<p>
				For a real editor, bind it to{" "}
				<a href="/docs/editors">ProseMirror or Lexical</a>.
			</p>

			<h2>Trees</h2>
			<p>
				<code>tree(schema)</code> is an ordered, movable hierarchy. Each node
				carries a typed payload in <code>data</code>. Moves keep the subtree and
				its proxies; concurrent moves resolve deterministically and cycles are
				cut predictably.
			</p>
			<CodeBlock title="outline.ts" code={trees} />
			<ul>
				<li>
					Indices refer to the final sibling list, after the moved node is
					removed. Omit the index to append.
				</li>
				<li>
					<code>snapshot()</code> returns the flat stored form, including
					tombstones. <code>toJSON()</code> returns the visible hierarchy.
				</li>
				<li>Moving a node into its own subtree throws before committing.</li>
			</ul>

			<Note>
				Supported leaves: finite numbers, bigint, well-formed strings, booleans,
				null, undefined, dates, dense arrays, plain objects and{" "}
				<code>Uint8Array</code>. Class instances and cycles are rejected.
			</Note>
		</>
	);
}
