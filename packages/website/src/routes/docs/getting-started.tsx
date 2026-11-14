import { Seo } from "~/components/Seo";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";

const install = `bun add pulsify-core
# or: npm install pulsify-core`;

const define = `import { array, definePulse, object } from "pulsify-core";

export const Note = definePulse("Note", object({
  title: "string",
  tags: array("string"),
  author: object({ name: "string" }),
})).materialize();`;

const create = `import { createPulse, subscribePulse, snapshotPulse } from "pulsify-core";
import { Note } from "./note";

const note = createPulse(Note, {
  title: "Draft",
  tags: ["work"],
  author: { name: "Ada" },
});

// Runs now, then after every committed change.
subscribePulse(note, (n) => console.log(n.title, n.tags.length));

note.title = "Ready";
note.tags.push("review");
note.author.name = "Grace";

snapshotPulse(note); // plain, detached copy`;

const local = `import { createMemoryConnector, createPulse } from "pulsify-core";

// Built-in local connector: in-process relay, kind "local".
const local = createMemoryConnector();

const note = createPulse(Note, { title: "Draft", tags: [], author: { name: "Ada" } }, {
  connectors: [local],
  connect: true,
});`;

const remote = `import {
  createMemoryConnector, createWebSocketConnector, loadPulse,
} from "pulsify-core";

const local = createMemoryConnector();
const remote = createWebSocketConnector("wss://sync.example.com/sync");

// Local connectors answer first: \`ready\` resolves before the network does.
const note = await loadPulse(Note, "note-42", {
  connectors: [local, remote],
});

note.title = "Edited on this device"; // uploaded in one batched frame`;

const loadOrCreate = `import { connectPulse, createPulse, loadPulse, PulseError } from "pulsify-core";

async function openNote(id: string) {
  try {
    return await loadPulse(Note, id, { connectors: [remote] });
  } catch (error) {
    if (!(error instanceof PulseError) || error.code !== "NOT_FOUND") throw error;
    const note = createPulse(Note, { id, title: "Untitled", tags: [], author: { name: "" } }, {
      connectors: [remote],
    });
    await connectPulse(note).synced;
    return note;
  }
}`;

export default function GettingStarted() {
	return (
		<>
			<Seo
				title="Getting started · Pulsify Docs"
				description="Install Pulsify and build a collaborative document that renders instantly, edits offline and syncs with a remote database."
			/>
			<h1>Getting started</h1>
			<p>
				From an empty file to a document that renders instantly, edits offline
				and syncs with a remote database. Migrations come later; this page uses
				a single schema version.
			</p>

			<h2>Install</h2>
			<CodeBlock title="terminal" code={install} />
			<p>
				Pulsify runs in browsers, Bun, Node 22+, Deno 2 and Cloudflare Workers.
				Schemas come from <code>@gin-quin/codec</code>, a small binary
				serialization library that doubles as the type system. It ships with
				Pulsify and its builders are re-exported from <code>pulsify-core</code>.
			</p>

			<h2>Define a pulse</h2>
			<p>
				A definition has a kind, a schema and a materializer. Call{" "}
				<code>.materialize()</code> with no arguments to expose the schema as
				is.
			</p>
			<CodeBlock title="note.ts" code={define} />

			<h2>Create and edit</h2>
			<p>
				A pulse is a proxy over the CRDT. Assign fields, push to arrays, mutate
				nested objects. Each write is validated against the schema, committed
				and announced to subscribers synchronously.
			</p>
			<CodeBlock title="app.ts" code={create} />

			<h2>Persist locally</h2>
			<p>
				Connectors are either <code>local</code> or <code>remote</code>. Local
				ones are tried first so the UI never waits for the network. Remote
				connectors only start once local ones have answered, and they send the
				version they already have, so servers return only what is missing
				locally instead of the whole pulse. The built-in local connector is an
				in-memory relay, which is also what you use in tests.
			</p>
			<CodeBlock title="app.ts" code={local} />

			<h2>Bind it to your UI</h2>
			<p>
				Pulsify has no framework dependency. Pick your framework in the Frontend
				section: <a href="/docs/frontend/svelte">Svelte</a>,{" "}
				<a href="/docs/frontend/solid">Solid</a>,{" "}
				<a href="/docs/frontend/react">React</a> or{" "}
				<a href="/docs/frontend/vue">Vue</a>. Each page shows how to render,
				edit and load a pulse on the client: pulses are never created or loaded
				during server rendering.
			</p>

			<h2>Sync to a server</h2>
			<p>
				Add a second connector. The WebSocket connector talks to any Pulsify
				relay: your own server in front of your database, or{" "}
				<a href="/cloud">Pulsify Cloud</a>. Writes are batched per microtask and
				uploaded as one frame.
			</p>
			<CodeBlock title="app.ts" code={remote} />
			<p>
				<code>loadPulse</code> resolves when usable data is available. Await{" "}
				<code>connectPulse(note).synced</code> instead when you need every
				connector to have acknowledged your history.
			</p>

			<h3>Load or create</h3>
			<p>
				Loading an unknown ID rejects with <code>NOT_FOUND</code>. The usual
				pattern creates the document with the same ID.
			</p>
			<CodeBlock title="openNote.ts" code={loadOrCreate} />

			<Note>
				Going offline is a function call: <code>disconnectPulse(note)</code>.
				Keep editing, then <code>connectPulse(note)</code>. Concurrent edits
				merge deterministically. See <a href="/docs/sync">Sync and offline</a>.
			</Note>
		</>
	);
}
