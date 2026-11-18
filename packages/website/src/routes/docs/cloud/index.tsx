import { Seo } from "~/components/Seo";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";
import { SequenceDiagram } from "~/components/SequenceDiagram";

const tree = `alice                     root: one namespace, one actor
├── alice/notes/n1        sub-document
├── alice/notes/n2        sub-document
└── alice/work            sub-document
    └── alice/work/plan   sub-document of a sub-document
bob                       another root, isolated from alice
acme                      a root does not have to be a user`;

const connector = `import { createCloudConnector } from "pulsify-cloud";
import { loadPulse } from "pulsify-core";

const cloud = createCloudConnector({
  url: "https://api.pulsify.cloud/<your-project>",
  token: () => fetch("/api/pulsify-token").then((response) => response.text()),
});

const notebook = await loadPulse(Notebook, "alice", { connectors: [cloud] });
cloud.connections; // [{ root: "alice", state: "open", documents: ["alice", "alice/notes/n1", …], … }]`;

const subscriptions = `// Everything reachable from the root: sub-pulses load by default
await loadPulse(Notebook, "alice", { connectors: [cloud] });

// The root document only
await loadPulse(Notebook, "alice", { connectors: [cloud], subPulses: false });

// One sub-document and all its children, without its parent
await loadPulse(Folder, "alice/work", { connectors: [cloud] });

// Selected sub-documents: load the root alone, then the references you need
const root = await loadPulse(Notebook, "alice", { connectors: [cloud], subPulses: false });
await Promise.all(root.notes.map((ref) => ref.load({ subPulses: false })));

// Unsubscribe: the socket stays open for the other documents of the root
destroyPulse(note); // or disconnectPulse(note)`;

const wire = `GET  /v1/health                         { "ok": true }
GET  /v1/roots/{root}/connect           WebSocket, one per user and root
GET  /v1/roots/{root}/grants            list grants
PUT  /v1/roots/{root}/grants            create or replace a grant
DELETE /v1/roots/{root}/grants?subject=…&prefix=…
GET  /v1/roots/{root}/usage             documents, rows, bytes, sockets (API key)
DELETE /v1/roots/{root}/documents?docId=…   erase a document and its subtree
PUT  /v1/roots/{root}/expire            {"idleMs":…}: erase the root once idle

Subprotocols offered by the client:
  pulsify-cloud.1.e2, pulsify-cloud.1.e1, pulsify-cloud.token.<jwt>
Binary frames: unchanged Pulsify frames, each names its document
Text frames:   {"type":"welcome","server":{backend,id,location?}} server → client, first frame
               {"type":"role","docId":…,"role":"editor"|…|null}   server → client
               {"type":"unsubscribe","docId":…}                    client → server
               {"type":"ping"} → {"type":"pong"}                   socket heartbeat`;

export default function CloudOverview() {
	return (
		<>
			<Seo
				title="How Pulsify Cloud works · Pulsify Docs"
				description="Pulsify Cloud is a managed CRDT database: each root is a Durable Object with its own SQLite database. Keep your code and change only the connector."
			/>
			<h1>How Pulsify Cloud works</h1>
			<p>
				Pulsify Cloud is the managed, paid backend for your pulses: a CRDT
				database you never operate. The client code is the one you already write
				with <code>pulsify-core</code>; only the connector changes. It runs on
				Cloudflare: each root is a Durable Object with its own SQLite database.
			</p>
			<p>
				Sign in to the <a href="/dashboard">dashboard</a> to get your project:
				its URL, <code>https://api.pulsify.cloud/&lt;your-project&gt;</code>,
				and its two secrets, <code>PULSIFY_TOKEN_SECRET</code> and{" "}
				<code>PULSIFY_API_KEY</code>. Or run the same server on your machine:
				see <a href="/docs/cloud/local">Local development</a>.
			</p>
			<ul>
				<li>
					<strong>Automatic scaling.</strong> Each root document is its own
					isolated actor with its own storage. A million users means a million
					small actors, not one big database.
				</li>
				<li>
					<strong>Global distribution.</strong> A root lives near its first user
					and is reachable from every location.
				</li>
				<li>
					<strong>Pay as you go.</strong> Idle sockets hibernate. You pay for
					activity and storage, not for capacity.
				</li>
				<li>
					<strong>Built-in authentication.</strong> Users connect with a token
					from your backend; each root keeps its own access table, and changes
					apply to open sockets immediately.
				</li>
			</ul>

			<h2>Roots and documents</h2>
			<p>
				A document belongs to the root named before its first <code>/</code>:{" "}
				<code>toto/tata</code> belongs to <code>toto</code>. Sub-pulses created
				with <code>{"{ parent }"}</code> get such IDs automatically, so a whole
				tree lives in one root.
			</p>
			<CodeBlock title="one root per namespace" code={tree} />
			<p>
				A root is usually a user, but nothing enforces it. Use a team, an
				organization or a project if that is how your data is shared. Pick roots
				so that the documents edited together live together: a root is the unit
				of placement, storage and isolation.
			</p>

			<h2>One socket per user and root</h2>
			<p>
				The connector opens <strong>one WebSocket per root</strong> and
				multiplexes every document of that root over it. Pulsify frames already
				name their document, so the cloud routes them without decoding the
				operations. Ten open notes cost one socket.
			</p>
			<SequenceDiagram
				caption="One socket, many documents. The root checks each document against its access table."
				actors={["Client", "Gateway", "Root alice"]}
				steps={[
					{ from: 0, to: 1, label: "upgrade /v1/roots/alice + token" },
					{ from: 1, to: 1, label: "verify token → subject" },
					{ from: 1, to: 2, label: "socket + subject" },
					{ from: 0, to: 2, label: "connect alice" },
					{ from: 2, to: 0, label: "role owner, sync alice", reply: true },
					{ from: 0, to: 2, label: "connect alice/notes/n1" },
					{ from: 2, to: 0, label: "role owner, sync n1", reply: true },
					{
						from: 2,
						to: 0,
						label: "updates of alice and n1 only",
						reply: true,
					},
				]}
			/>
			<CodeBlock title="cloud.ts" code={connector} />

			<h2>Subscriptions</h2>
			<p>
				Loading a pulse subscribes to it; the server never pushes documents you
				did not load. Subscribe to exactly what a screen needs:
			</p>
			<CodeBlock title="subscriptions.ts" code={subscriptions} />
			<p>
				Each subscription has its own version vector, so opening a document
				downloads only its missing rows. When the last document of a root is
				closed, the socket closes after <code>lingerMs</code> (5 seconds by
				default).
			</p>
			<p>
				A socket that dies is replaced, and one that dies silently is found out:
				see <a href="/docs/cloud/connections">Connections</a>.
			</p>

			<h2>Storage and access</h2>
			<p>Each root stores three things:</p>
			<ul>
				<li>
					<strong>Patch rows</strong> of all its documents, in the same schema
					as the self-hosted stores. They are never decoded on the server:
					definitions, migrations and materializers stay in your client code.
				</li>
				<li>
					<strong>Grants</strong>: who can read, edit or own which prefix. See{" "}
					<a href="/docs/cloud/authentication">Authentication</a>.
				</li>
				<li>
					<strong>Subscriptions</strong> of the sockets currently open, so a
					hibernated root wakes up knowing whom to notify.
				</li>
			</ul>
			<p>
				To delete documents, keep snapshots of them or let a root expire, see{" "}
				<a href="/docs/cloud/documents">Managing documents</a>.
			</p>

			<h2>Plans and limits</h2>
			<p>
				Each project is metered over the month on three quantities. See{" "}
				<a href="/pricing">Pricing</a> for the prices.
			</p>
			<ul>
				<li>
					<strong>Messages</strong>: the binary frames clients send,{" "}
					<code>connect</code>, <code>syncBack</code> and <code>update</code>.
					Presence frames do not count, and broadcasts are free: delivering one
					change to fifty peers is one message.
				</li>
				<li>
					<strong>Storage</strong>: the size of the databases of your roots.
				</li>
				<li>
					<strong>Live connections</strong>: open sockets across all your roots.
				</li>
			</ul>
			<p>At the limits:</p>
			<ul>
				<li>
					<strong>Free, over messages or storage</strong>: uploads fail with{" "}
					<code>LIMIT_EXCEEDED</code>. Loading and receiving updates keep
					working.
				</li>
				<li>
					<strong>Any plan, over its connection limit</strong>: new sockets are
					refused with <code>LIMIT_EXCEEDED</code> (HTTP 413). Open sockets stay
					open.
				</li>
				<li>
					<strong>Pro</strong>: messages and storage beyond the included amounts
					are billed, never blocked.
				</li>
			</ul>
			<Note>
				Rotating a secret on the dashboard takes effect within a minute: update
				your backend right away.
			</Note>

			<h2>Packages</h2>
			<table>
				<thead>
					<tr>
						<th>Import</th>
						<th>Contains</th>
						<th>License</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td>
							<code>pulsify-cloud</code>
						</td>
						<td>
							The client: connector, user activity, management client, tokens,
							roles and the session protocol.
						</td>
						<td>Apache-2.0</td>
					</tr>
					<tr>
						<td>
							<code>pulsify-cloud-server</code>
						</td>
						<td>
							The server: the gateway and <code>CloudRoot</code>, the
							runtime-independent state machine of a root. Its{" "}
							<code>pulsify dev</code> command runs it on your machine.
						</td>
						<td>
							FSL-1.1-ALv2: any use except a competing service; Apache-2.0 two
							years after each release
						</td>
					</tr>
				</tbody>
			</table>

			<h2>Wire protocol</h2>
			<CodeBlock title="cloud session protocol 1" code={wire} />
			<p>
				Paths are relative to your project URL:{" "}
				<code>https://api.pulsify.cloud/&lt;your-project&gt;/v1/health</code>.
			</p>
			<p>
				The token travels as a WebSocket subprotocol because browsers cannot set
				headers on a socket; the server answers with the envelope only. Envelope
				2 groups scalar runs; the server may still answer in envelope 1.
			</p>
			<Note>
				Root and document IDs follow the core limits: well-formed Unicode, no
				NUL, at most 1,024 UTF-16 units. A root cannot contain <code>/</code>. A
				root holds at most 10,000 grants.
			</Note>
		</>
	);
}
