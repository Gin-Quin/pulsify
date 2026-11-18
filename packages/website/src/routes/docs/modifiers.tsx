import { Seo } from "~/components/Seo";
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

const versions = `import { counter, definePulse, object, versioned } from "pulsify-core";

const Invoice = definePulse("Invoice", object({
  title: "string",                                   // last value only
  status: versioned("string"),                       // every write is kept
  total: versioned("float64", { timestamps: true }), // and the time of each write
  views: counter(),                                  // last count per peer
  edits: versioned(counter()),                       // every change
})).materialize();

// A whole document, or any object inside one:
const Audited = definePulse("Audited", versioned(object({ title: "string" })));`;

const versionsMigration = `const v1 = object({ status: "string" });
const v2 = object({ status: versioned("string") });

const Invoice = definePulse("Invoice", v1)
  .migrateTo(v2, () => ({})) // the value stays; history starts here
  .materialize();`;

const past = `import { getPulseHistory, snapshotPulse } from "pulsify-core";

// The writes of a versioned field, oldest first.
getPulseHistory(invoice, "total");
// [{ value: 10, version, actor, time }, { value: 12, version, actor, time }]
getPulseHistory(invoice, "total", { since: lastMonth }); // a Date, or a version

// Every transaction of the document, then the document as it was.
const versions = getPulseHistory(audited); // [{ version, actor, time? }]
const first = snapshotPulse(audited, { at: versions[0].version });
const monday = snapshotPulse(audited, { at: new Date("2026-11-16T09:00") });`;

const restore = `import { restorePulse } from "pulsify-core";

restorePulse(audited, versions[3].version);
restorePulse(audited, new Date("2026-11-16T09:00"));

audited.generation; // 0 at creation, one more after each restore`;

const snapshots = `import { exportPulseUpdates, openPulseSnapshot, restorePulse } from "pulsify-core";

const frames = exportPulseUpdates(note, []); // Uint8Array[]: store them anywhere

const saved = openPulseSnapshot(Note, note.id, frames); // a read-only pulse
restorePulse(note, saved);
destroyPulse(saved);`;

const combined = `object({
  label: optional(constant("string")), // may be absent, never changes once created
  snapshot: optional(frozen(object({ x: "float64", y: "float64" }))),
})`;

export default function Modifiers() {
	return (
		<>
			<Seo
				title="Value modifiers · Pulsify Docs"
				description="Modifiers change how a field can be written, not what it stores. Pulsify enforces them on every replica, and TypeScript at compile time."
			/>
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
				can be neither replaced nor edited, deeply. Inside an array or a record,
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
				snapshots. It requires a structured schema (object, array, tuple,
				record); a frozen primitive would just be a plain field.
			</p>
			<CodeBlock title="board.ts" code={frozens} />

			<h2>Literal</h2>
			<p>
				A <code>literal(value)</code> field can only ever hold that value, so it
				is constant. Literals inside a <code>union</code> are just the allowed
				values of an editable field.
			</p>
			<CodeBlock title="shape.ts" code={literals} />

			<h2 id="versioned">Versioned</h2>
			<p>
				A field keeps its last value only: writing it again replaces the
				previous write in every store, so a database grows with the size of its
				documents, not with the number of edits. <code>versioned(schema)</code>{" "}
				keeps every write of a value, and of everything inside it.{" "}
				<code>timestamps</code> also records when each write was made, from the
				writer's clock: the time of the edit, even offline, which a client could
				forge.
			</p>
			<CodeBlock title="invoice.ts" code={versions} />
			<p>
				Text, arrays and trees always keep their history, since every edit is
				part of the result, and so does an assignment that creates an object, an
				array, a text or a counter. What peers see does not change: the same
				write wins everywhere.
			</p>
			<p>
				Changing the mode of a field is a schema change, made by a migration
				step. The value stays as it is. Turned on, history starts at that
				version; turned off, it stops, and the rows already stored stay.
			</p>
			<CodeBlock title="invoice.ts" code={versionsMigration} />
			<Note>
				A document created before version 13 keeps the history it has, and its
				fields stop adding to it.
			</Note>

			<h3 id="history">Read the past</h3>
			<p>
				A pulse holds the history of its document, so reading it needs no
				server. <code>getPulseHistory</code> lists the writes of a versioned
				field with the value each one gave it, or every transaction of the
				document. A version is a version vector: plain data, ordered the same
				way on every replica.
			</p>
			<CodeBlock title="history.ts" code={past} />
			<p>
				A field must be <code>versioned()</code>, or a text: any other field has
				no past, and asking for it throws.{" "}
				<code>snapshotPulse(pulse, {"{ at }"})</code> needs a document whose
				whole schema is <code>versioned()</code>, so that the copy is exact, and{" "}
				<code>timestamps</code> to take a date. The migrations added since that
				version are applied to the copy.
			</p>

			<h3 id="restore">Restore a version</h3>
			<p>
				A restore is a write like another: it travels to every replica and stays
				in the history, so restoring the version before it undoes it. It
				replaces the whole document by a new <strong>generation</strong> of it,
				with the content of the version, texts with their formatting.
			</p>
			<CodeBlock title="restore.ts" code={restore} />
			<ul>
				<li>
					Edits made to an earlier generation are discarded on every replica,
					whatever the order of arrival: someone who kept typing without having
					received the restore loses those edits when it arrives.
				</li>
				<li>
					When two people restore while offline and keep editing, one restore
					wins on every replica, with the edits that followed it. The other one
					and its edits are discarded.
				</li>
				<li>
					Objects, arrays and texts read before the restore are replaced. Read
					them from the pulse again, and bind an editor again when{" "}
					<code>pulse.generation</code> changes.
				</li>
				<li>
					Where the document keeps every write up to that version, the restore
					only names it: a few bytes, and every replica rebuilds the version
					from its own history. Otherwise it carries the content, which must fit
					one transaction of 1 MiB.
				</li>
				<li>Versions before 15 cannot read a document that was restored.</li>
			</ul>

			<h3 id="snapshots">Snapshots</h3>
			<p>
				For a document that keeps every write, a snapshot is its version:{" "}
				<code>getPulseVersions(pulse).state</code>, plain data to store and give
				back to <code>restorePulse</code>. A document that is not{" "}
				<code>versioned()</code> keeps no past: keep copies of it at the moments
				that matter instead. A copy is the frames of the document, which hold
				what it has now and nothing of what it dropped. Opening one gives a
				read-only pulse, to which the migrations added since are applied.{" "}
				<a href="/docs/cloud#snapshots">Pulsify Cloud</a> keeps snapshots on the
				server, with their time and author.
			</p>
			<CodeBlock title="snapshot.ts" code={snapshots} />

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
