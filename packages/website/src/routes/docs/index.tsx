import { Title } from "@solidjs/meta";
import { CodeBlock } from "~/components/CodeBlock";

const typed = `const Todo = definePulse("Todo", object({
  title: "string",
  done: "boolean",
  tags: array("string"),
})).materialize();

const todo = createPulse(Todo, { title: "Ship", done: false, tags: [] });
todo.done = true;        // typed, validated, synced
todo.done = "yes";       // TypeScript error, and rejected at runtime`;

export default function Why() {
	return (
		<>
			<Title>Why Pulsify · Docs</Title>
			<h1>Why Pulsify</h1>
			<p>
				Pulsify is a CRDT framework for TypeScript. A <strong>pulse</strong> is
				a typed collaborative document that looks like a plain object, merges
				edits from any number of peers without conflicts, and persists as rows
				in PostgreSQL or SQLite.
			</p>

			<h2>Fully typed</h2>
			<p>
				Yjs and Loro expose untyped maps, arrays and texts. You write the
				schema in your head, and every reader re-validates. In Pulsify the
				schema is code: it produces the TypeScript type, the runtime checks and
				the binary layout.
			</p>
			<CodeBlock title="todo.ts" code={typed} />

			<h2>Built-in migrations</h2>
			<p>
				Shipped documents outlive your schema. Pulsify lets you append a
				migration step and upgrades each document lazily, when it is loaded.
				There is no batch job, and a client running old code is detected
				instead of silently corrupting data.{" "}
				<a href="/docs/migrations">Migrations →</a>
			</p>

			<h2>Materialization</h2>
			<p>
				CRDTs never really delete a field. Materialization gives the rest of
				your codebase one clean, current type built from the latest version,
				while the stored shape stays compatible with every peer.{" "}
				<a href="/docs/materialization">Materialization →</a>
			</p>

			<h2>PostgreSQL and SQLite</h2>
			<p>
				Every change is an immutable row keyed by document, actor and clock.
				The server answers “what is this client missing?” with one indexed
				query and never decodes or loads a document. Appends are one round
				trip. <a href="/docs/databases">Databases →</a>
			</p>

			<h2>Fast</h2>
			<p>
				Local writes keep native patches and are encoded once, only when a peer
				needs them. On a 1,000-item document, Pulsify creates and encodes in
				about 60% of Yjs's time and 7% of Loro's, and single edits are several
				times faster.{" "}
				<a href="/benchmarks">
					Full benchmark →
				</a>
			</p>

			<h2>Everything else</h2>
			<ul>
				<li>Rich text with ProseMirror and Lexical bindings.</li>
				<li>Arrays with move, trees with reparenting, tuples, optionals, unions.</li>
				<li>Offline edits that merge on reconnection.</li>
				<li>Browsers, Bun, Node 22+, Deno 2 and Cloudflare Workers.</li>
				<li>A versioned binary protocol, also implemented in Rust.</li>
			</ul>
		</>
	);
}
