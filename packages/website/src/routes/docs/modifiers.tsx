import { Title } from "@solidjs/meta";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";

const optionals = `import { definePulse, object, optional } from "pulsify-core";

const User = definePulse("User", object({
  name: "string",
  avatar: optional("string"),
  address: optional(object({ city: "string" })),
})).materialize();

const user = createPulse(User, { name: "Ada" });
user.avatar = "ada.png";
user.avatar = undefined;          // removes the field
user.address = { city: "Paris" }; // creates the nested object
user.address.city = "Lyon";       // then edits it field by field`;

const constants = `import { array, constant, definePulse, object } from "pulsify-core";

const Article = definePulse("Article", object({
  origin: constant(object({ source: "string", importedAt: "date" })),
  items: array(object({ id: constant("string"), label: "string" })),
})).materialize();

const article = createPulse(Article, {
  origin: { source: "rss", importedAt: new Date() },
  items: [{ id: "a1", label: "First" }],
});

article.origin = { source: "x", importedAt: new Date() }; // rejected
article.origin.source = "x";                             // rejected
article.items[0]!.id = "b2";                             // rejected
article.items[0]!.label = "Renamed";                     // ok
article.items.push({ id: "b2", label: "Second" });       // ok: new element, new constant`;

const frozens = `import { array, definePulse, frozen, object, tuple } from "pulsify-core";

const Board = definePulse("Board", object({
  cover: frozen(tuple("uint", "uint")),
  settings: frozen(object({ tags: array("string") })),
  points: array(frozen(tuple("float64", "float64"))),
})).materialize();

board.cover = [800, 600];            // ok: replaced as a whole
board.cover[0] = 800;                // rejected
board.settings.tags.push("new");     // rejected
board.settings = { tags: ["new"] };  // ok
board.points[0] = [3, 4];            // ok: replaces one element
board.points[0]![0] = 3;             // rejected`;

const literals = `import { definePulse, literal, object, union } from "pulsify-core";

const Shape = definePulse("Shape", object({
  type: literal("shape"),                             // constant
  theme: union([literal("light"), literal("dark")]),  // editable union
})).materialize();

shape.type = "other";  // rejected
shape.theme = "dark";  // ok: the field is a union, not a literal`;

const combined = `object({
  label: optional(constant("string")), // may be absent, never changes once created
  snapshot: optional(frozen(object({ x: "float64", y: "float64" }))),
})`;

export default function Modifiers() {
	return (
		<>
			<Title>Value modifiers · Docs</Title>
			<h1>Value modifiers</h1>
			<p>
				Modifiers wrap a schema to change how it can be written, not what it
				stores. The wire format is the same; Pulsify enforces the rule on every
				replica, and TypeScript enforces it at compile time.
			</p>
			<table>
				<thead>
					<tr>
						<th>Modifier</th>
						<th>Absent</th>
						<th>Replace</th>
						<th>Edit contents</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td>
							<code>optional(schema)</code>
						</td>
						<td>yes</td>
						<td>yes</td>
						<td>yes</td>
					</tr>
					<tr>
						<td>
							<code>frozen(schema)</code>
						</td>
						<td>no</td>
						<td>yes</td>
						<td>no</td>
					</tr>
					<tr>
						<td>
							<code>constant(schema)</code>
						</td>
						<td>no</td>
						<td>no</td>
						<td>no</td>
					</tr>
					<tr>
						<td>
							<code>literal(value)</code>
						</td>
						<td>no</td>
						<td>no</td>
						<td>—</td>
					</tr>
				</tbody>
			</table>

			<h2>Optional</h2>
			<p>
				<code>optional(schema)</code> allows <code>undefined</code>. Assigning{" "}
				<code>undefined</code> removes the field; assigning a value again
				recreates it, and later edits target the new value.
			</p>
			<CodeBlock title="user.ts" code={optionals} />

			<h2>Constant</h2>
			<p>
				<code>constant(schema)</code> keeps the value it was created with: it
				can be neither replaced nor edited, deeply. Inside an array or a map,
				each element gets its own constant when it is inserted. Use it for
				identifiers, provenance and anything other code relies on staying put.
			</p>
			<CodeBlock title="article.ts" code={constants} />

			<h2>Frozen</h2>
			<p>
				<code>frozen(schema)</code> is a value replaced only as a whole. Its
				contents are deeply readonly, so concurrent replacements never
				interleave: one complete value wins. Use it for small structured values
				that only make sense together, like coordinates, ranges or settings
				snapshots. It requires a structured schema (object, array, tuple, map);
				a frozen primitive would just be a plain field.
			</p>
			<CodeBlock title="board.ts" code={frozens} />

			<h2>Literal</h2>
			<p>
				A <code>literal(value)</code> field can only ever hold that value, so it
				is constant. Literals inside a <code>union</code> are just the allowed
				values of an editable field.
			</p>
			<CodeBlock title="shape.ts" code={literals} />

			<h2>Combining modifiers</h2>
			<p>
				<code>optional</code> wraps <code>constant</code> and{" "}
				<code>frozen</code>. Rich text and tree containers are collaborative by
				nature, so <code>constant(richText())</code>,{" "}
				<code>frozen(object({"{ body: richText() }"}))</code> and constant trees
				are rejected when the schema is compiled. A tree's payload can still be
				constant.
			</p>
			<CodeBlock title="combined.ts" code={combined} />

			<Note>
				Rejected writes throw before anything is committed, and replicas reject
				the same writes when they arrive from peers.
			</Note>
		</>
	);
}
