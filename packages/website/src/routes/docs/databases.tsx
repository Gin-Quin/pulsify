import { Title } from "@solidjs/meta";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";
import { GITHUB_URL } from "~/components/links";

const server = `import { PulseRelay, type RelayPeer } from "pulsify-core";

const relay = new PulseRelay();

Bun.serve<{ peer?: RelayPeer }>({
  port: 3000,
  fetch(request, server) {
    if (new URL(request.url).pathname !== "/sync") return new Response("Not found", { status: 404 });
    const offered = request.headers.get("sec-websocket-protocol") ?? "";
    const version = offered.includes("pulsify-v3") ? 3 : 1;
    const headers = version > 1 ? { "Sec-WebSocket-Protocol": "pulsify-v3" } : {};
    return server.upgrade(request, { data: {}, headers }) ? undefined : new Response(null, { status: 400 });
  },
  websocket: {
    open(socket) {
      socket.data.peer = relay.open((bytes) => socket.sendBinary(bytes), { protocolVersion: 3 });
    },
    message(socket, message) {
      if (typeof message === "string") return socket.close(1003);
      socket.data.peer!.receive(new Uint8Array(message));
    },
    close(socket) { socket.data.peer?.close(); },
  },
});`;

const postgres = `import { SQL } from "bun";
import { PostgresPatchStore } from "pulsify-core/storage";

const sql = new SQL(process.env.DATABASE_URL!);
const store = new PostgresPatchStore((query, params) => sql.unsafe(query, params as never[]));
await store.initialize(); // once, installs tables and pulsify_append()

// Persist an incoming update frame: one round trip, no document decoding.
await store.appendEncoded(frameBytes);

// Serve a client: rows it has not seen, straight from the index.
const rows = await store.missing(docId, clientVersionVector);
const vector = await store.vector(docId);`;

const sqlite = `import { Database } from "bun:sqlite";
import { SqlitePatchStore } from "pulsify-core/storage";

const store = new SqlitePatchStore(new Database("pulsify.db"));
await store.initialize();
await store.appendEncoded(frameBytes);`;

const custom = `import type { PatchStore } from "pulsify-core/storage";

class MyPatchStore implements PatchStore {
  append(rows) { /* insert a batch atomically */ }
  appendEncoded(frame) { /* same, from an update frame */ }
  vector(docId) { /* contiguous frontier per actor */ }
  missing(docId, remoteVector) { /* rows the client lacks */ }
}`;

const cloud = `import { createCloudConnector } from "pulsify-cloud";

const cloud = createCloudConnector({ url: PULSIFY_URL, token: fetchToken });
const note = await loadPulse(Note, "alice/notes/n1", { connectors: [cloud] });`;

export default function Databases() {
	return (
		<>
			<Title>Self-host: databases · Docs</Title>
			<h1>Self-host: databases</h1>
			<p>
				A Pulsify server is a relay plus a store. Run both yourself in front of
				your own database, or let Pulsify Cloud do it. Stores for PostgreSQL and
				SQLite are included; any other database can implement the same
				interface.
			</p>

			<h2>How storage works</h2>
			<p>
				Every committed change is an immutable row:{" "}
				<code>(docId, actor, clock, span, dependencies, bytes)</code>. The store
				never decodes operations or instantiates a schema. Two queries do all
				the work:
			</p>
			<ul>
				<li>
					<code>vector(docId)</code> returns the contiguous causal frontier per
					actor.
				</li>
				<li>
					<code>missing(docId, remoteVector)</code> returns only the rows a
					client lacks, by index, <strong>without loading the document</strong>.
				</li>
			</ul>
			<p>
				Rows arriving out of order stay dangling until their predecessors land,
				so a partially uploaded history can never be served as complete.
				Duplicates are idempotent; forks of one actor's history roll back the
				whole batch.
			</p>

			<h2>Self-host: relay</h2>
			<p>
				The relay fans frames out to connected peers of the same document and
				answers initial downloads. The reference relay is in-memory; add the
				store at the boundary and append before acknowledging.
			</p>
			<CodeBlock title="server.ts" code={server} />

			<h2>Self-host: PostgreSQL</h2>
			<p>
				PostgreSQL is the primary target. An append is one call to{" "}
				<code>pulsify_append</code>, which takes a per-document advisory lock,
				checks only neighboring segments, inserts the batch and promotes rows
				whose dependencies are now met. Payloads are <code>bytea[]</code>, never
				base64.
			</p>
			<CodeBlock title="store.ts" code={postgres} />
			<p>
				Any driver works as long as it binds the third parameter as a binary
				array. Bun's SQL does; a <code>pg</code> adapter must preserve{" "}
				<code>Uint8Array</code> values.
			</p>

			<h2>Self-host: SQLite</h2>
			<p>
				Same API, same indexes, immediate transactions. Ideal for single-node
				servers, desktop apps and tests.
			</p>
			<CodeBlock title="store.ts" code={sqlite} />
			<p>
				Measurements and the conformance suite for both stores are in the{" "}
				<a href={`${GITHUB_URL}/blob/main/docs/STORAGE.md`}>storage guide</a>.
			</p>

			<h2>Self-host: another database</h2>
			<p>
				Nothing in the protocol depends on SQL. A store is any object that
				implements <code>PatchStore</code>, and <code>relayStoreMessage</code>{" "}
				serves frames from any of them. Keep the rules above (immutable rows,
				idempotent duplicates, atomic batches, dangling rows until their
				dependencies land) and any database with ordered keys and atomic writes
				can hold pulses.
			</p>
			<CodeBlock title="store.ts" code={custom} />

			<h2>Or use Pulsify Cloud</h2>
			<p>
				The managed backend runs the same stores for you: one isolated root per
				namespace, one socket per user and root, built-in access control. From
				the client it is a connector.
			</p>
			<CodeBlock title="app.ts" code={cloud} />
			<p>
				<a href="/docs/cloud">How Pulsify Cloud works →</a>
			</p>

			<Note>
				Document IDs must be well-formed Unicode, contain no NUL and stay under
				1,024 UTF-16 units. A document supports up to 1,024 distinct actors.
			</Note>
		</>
	);
}
