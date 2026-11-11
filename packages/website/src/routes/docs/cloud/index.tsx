import { Title } from "@solidjs/meta";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";
import { SequenceDiagram } from "~/components/SequenceDiagram";
import { Tabs } from "~/components/Tabs";

const tree = `alice                     root: one namespace, one actor
├── alice/notes/n1        sub-document
├── alice/notes/n2        sub-document
└── alice/work            sub-document
    └── alice/work/plan   sub-document of a sub-document
bob                       another root, isolated from alice
acme                      a root does not have to be a user`;

const connector = `import { createCloudConnector } from "@pulsify/cloud";
import { loadPulse } from "@pulsify/core";

const cloud = createCloudConnector({
  url: "https://pulsify.example.com",                // Cloudflare or Unikraft: same URL scheme
  token: () => fetch("/api/pulsify-token").then((response) => response.text()),
});

const notebook = await loadPulse(Notebook, "alice", { connectors: [cloud], include: true });
cloud.connections; // [{ root: "alice", state: "open", documents: ["alice", "alice/notes/n1", …], … }]`;

const subscriptions = `// The root document only
await loadPulse(Notebook, "alice", { connectors: [cloud] });

// One sub-document, without its parent
await loadPulse(Note, "alice/notes/n1", { connectors: [cloud] });

// Everything reachable from the root
await loadPulse(Notebook, "alice", { connectors: [cloud], include: true });

// A sub-document and all its children
await loadPulse(Folder, "alice/work", { connectors: [cloud], include: true });

// Selected fields only
await loadPulse(Notebook, "alice", { connectors: [cloud], include: { notes: true } });

// Unsubscribe: the socket stays open for the other documents of the root
destroyPulse(note); // or disconnectPulse(note)`;

const heartbeat = `import { createCloudConnector, createPresence } from "@pulsify/cloud";

const cloud = createCloudConnector({
  url,
  token,
  heartbeat: {
    staleMs: 5_000,    // ping a socket silent this long before using it
    timeoutMs: 5_000,  // no frame this long after a ping: the socket is dead
    intervalMs: 2_000, // background check while someone is there; false = on demand only
  },                   // defaults; heartbeat: false relies on transport errors
  // Optional: by default every connector of the page shares \`presence\`.
  presence: createPresence({
    activeMs: 300_000,   // "someone is there": input within this long, page not hidden
    unfocusedMs: 30_000, // ...or within this long when the window lost focus
  }),
});`;

const tauriPresence = `// Tauri, desktop and mobile: minimized or hidden means away, shown or focused means back.
import { presence } from "@pulsify/cloud";
import { watchTauriPresence } from "@pulsify/tauri";

const stop = await watchTauriPresence(presence);`;

const electrobunPresence = `// Electrobun, main process (Bun): report the native window state.
const report = (present: boolean) => sendToWebview("presence", present); // your RPC message
const update = () => report(win.isVisible() && !win.isMinimized());
win.on("resize", update);
win.on("blur", update);
win.on("focus", () => report(true));

// Webview: hand it to the page presence, shared by every connector.
import { presence } from "@pulsify/cloud";

onPresenceMessage((present) => presence.set(present));`;

const debug = `import { presence } from "@pulsify/cloud";
import { subscribePulseStatus } from "@pulsify/core";

// The window: called now, then on every change. It involves no server.
presence.on("change", (p) => {
  // { present, reason: "blur" | "idle" | "focus" | "native" | …, visible, focused, away, lastActivity }
  presenceBadge.textContent = p.present ? "here" : \`away (\${p.reason})\`;
});

// The servers: one connection per root, to its Durable Object or Unikraft machine.
// Called with the current connections, then with each new one (reconnections included).
cloud.onConnection((connection) => {
  const { root } = connection;
  connection.on("server", ({ backend, id, location }) => log(root, "served by", backend, id, location));
  connection.on("state", (state, error) => log(root, state, error?.message)); // open | closed
  connection.on("ping", (reason) => log(root, "ping", reason)); // send | interval | network | return | resume
  connection.on("pong", (latencyMs) => log(root, "pong", latencyMs));
  connection.on("timeout", (waitedMs) => log(root, "dead socket", waitedMs));
  connection.on("suspended", (gapMs) => log(root, "process was suspended for", gapMs));
  connection.on("role", (docId, role) => log(docId, "role", role));
});

cloud.connections; // the current ones, without listening: root, state, server, documents, latencyMs, error
presence.state;    // the same for the window

// Documents: idle | syncing | ready | synced | offline | error.
subscribePulseStatus(notebook, (status) => (statusBadge.textContent = status));`;

const wire = `GET  /v1/health                         { "ok": true }
GET  /v1/roots/{root}/connect           WebSocket, one per user and root
GET  /v1/roots/{root}/grants            list grants
PUT  /v1/roots/{root}/grants            create or replace a grant
DELETE /v1/roots/{root}/grants?subject=…&prefix=…
GET  /v1/roots/{root}/usage             documents, rows, bytes, sockets (API key)

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
			<Title>How Pulsify Cloud works · Docs</Title>
			<h1>How Pulsify Cloud works</h1>
			<p>
				Pulsify Cloud is the managed, paid backend for your pulses: a CRDT
				database you never operate. The client code is the one you already write
				with <code>@pulsify/core</code>; only the connector changes.
			</p>
			<ul>
				<li>
					<strong>Automatic scaling.</strong> Each root document is its own
					isolated actor with its own storage. A million users means a million
					small actors, not one big database.
				</li>
				<li>
					<strong>Global distribution.</strong> On Cloudflare, a root lives near
					its first user and is reachable from every location.
				</li>
				<li>
					<strong>Pay as you go.</strong> Idle sockets hibernate and idle
					instances scale to zero. You pay for activity and storage, not for
					capacity.
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

			<h2>Lost connections</h2>
			<p>
				Connected pulses <a href="/docs/sync">reconnect on their own</a> with
				backoff, and every reconnection is a complete synchronization. All
				documents of a root come back on one new socket.
			</p>
			<p>
				A socket can also die without closing: a laptop that slept, a network
				switch, a proxy dropping idle connections. The connector checks sockets
				when they are needed, once per socket rather than per document:
			</p>
			<ul>
				<li>
					<strong>Before using a silent socket.</strong> An edit sent on a
					socket that received nothing for 5 seconds goes out with a ping. Any
					frame counts as an answer, so a busy socket never pings.
				</li>
				<li>
					<strong>When the user comes back.</strong> Focusing the window or
					showing the page checks silent sockets; the network coming back checks
					all of them.
				</li>
				<li>
					<strong>Without an answer within 5 seconds</strong>, the socket is
					closed and its documents reconnect, the edit included.
				</li>
				<li>
					<strong>Passive readers.</strong> Nothing needs a socket that only
					receives, so while someone is there (input in the last 5 minutes, page
					not hidden) a silent socket is pinged every 2 seconds. Any frame
					counts as an answer, so busy sockets never ping. Set{" "}
					<code>intervalMs: false</code> to check on demand only.
				</li>
				<li>
					<strong>A page left open</strong> (hidden, or untouched for 5 minutes)
					sends nothing at all, so the server can sleep. Its sockets stay open
					and still receive updates; if one died meanwhile, the first input,
					focus or edit finds out within 5 seconds and resynchronizes.
				</li>
			</ul>
			<CodeBlock title="cloud.ts" code={heartbeat} />
			<p>
				On Cloudflare the runtime answers pings itself: a hibernated root stays
				asleep and no duration is billed. Each ping still counts as an incoming
				WebSocket message, billed as 1/20 of a request. On Unikraft Cloud, a
				ping wakes a scaled-to-zero instance for a moment: only pages in use
				ping in the background, so instances sleep when users walk away.
			</p>
			<p>
				A screen nobody touches, such as a dashboard on an office TV or a kiosk,
				stops background pings after 5 minutes like any idle page. It still
				receives updates, but a socket that died silently would only be noticed
				at the next touch. Give such displays <code>activeMs: Infinity</code>.
			</p>

			<h3>Desktop and mobile apps</h3>
			<p>
				Presence works in every webview because it relies on what they all
				report: input events (pointer, keyboard, wheel, touch) and timers. When
				timers run late, the process was suspended (laptop sleep, mobile app in
				the background), and every socket is checked on resume. Visibility,
				focus, <code>pageshow</code> and <code>resume</code> only make detection
				faster where the webview reports them:
			</p>
			<table>
				<thead>
					<tr>
						<th>Runtime</th>
						<th>Page hidden when minimized or in the background</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td>Browsers, Electron (Chromium)</td>
						<td>Yes</td>
					</tr>
					<tr>
						<td>Tauri, Electrobun on macOS (WKWebView)</td>
						<td>On minimize, not when covered by another window</td>
					</tr>
					<tr>
						<td>Tauri, Electrobun on Windows (WebView2)</td>
						<td>
							Never (
							<a href="https://github.com/tauri-apps/tauri/issues/10592">
								tauri#10592
							</a>
							). Minimizing removes the focus, so pings stop 30 seconds after
							the last input; at once with native events.
						</td>
					</tr>
					<tr>
						<td>Tauri on iOS and Android</td>
						<td>
							The app is suspended in the background; sockets are checked on
							resume
						</td>
					</tr>
				</tbody>
			</table>
			<p>
				A window that loses focus (another app in front, or minimized) counts as
				away 30 seconds after the last input instead of 5 minutes. Every webview
				reports focus, including WebView2. To react the moment a window is
				minimized or hidden, forward the native state to the page{" "}
				<code>presence</code>, which every connector shares:
			</p>
			<Tabs
				tabs={[
					{
						label: "Tauri",
						content: <CodeBlock title="presence.ts" code={tauriPresence} />,
					},
					{
						label: "Electrobun",
						content: (
							<CodeBlock title="presence.ts" code={electrobunPresence} />
						),
					},
				]}
			/>
			<p>
				Electron needs nothing: Chromium reports minimized and hidden windows to
				the page.
			</p>

			<h2>Debugging and status displays</h2>
			<p>
				A client talks to several servers at once: each root it uses has its own
				socket, served by that root's Durable Object or Unikraft machine. So
				events are reported where they happen:
			</p>
			<ul>
				<li>
					<strong>Presence</strong> belongs to the window, not to any server:
					whether someone is there, and why.
				</li>
				<li>
					<strong>Each connection</strong> reports its own server (the first
					frame of every socket names the backend, the Durable Object ID or
					machine instance, and the Cloudflare edge or Unikraft metro), its
					lifecycle, every ping with why it was sent, round trips, a dead socket
					and process suspensions. A reconnection is a new connection; a new
					server ID means a new instance.
				</li>
				<li>
					<strong>Each pulse</strong> reports its synchronization status.
				</li>
			</ul>
			<p>Use them for a debug panel, logs, or to show the state of a window.</p>
			<CodeBlock title="debug.ts" code={debug} />

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

			<h2>Packages and backends</h2>
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
							<code>@pulsify/cloud</code>
						</td>
						<td>
							The client: connector, presence, management client, tokens, roles
							and the session protocol.
						</td>
						<td>Apache-2.0</td>
					</tr>
					<tr>
						<td>
							<code>@pulsify/cloud-server</code>
						</td>
						<td>
							The gateway and <code>CloudRoot</code>, the runtime-independent
							state machine of a root.
						</td>
						<td rowSpan={3}>
							FSL-1.1-ALv2: any use except a competing service; Apache-2.0 two
							years after each release
						</td>
					</tr>
					<tr>
						<td>
							<code>@pulsify/cloud-server/cloudflare</code>
						</td>
						<td>A Worker and one Durable Object per root.</td>
					</tr>
					<tr>
						<td>
							<code>@pulsify/cloud-server/unikraft-cloud</code>
						</td>
						<td>
							A Rust server and PostgreSQL in one Unikraft Cloud image, plus its
							schema.
						</td>
					</tr>
				</tbody>
			</table>
			<table>
				<thead>
					<tr>
						<th />
						<th>Cloudflare</th>
						<th>Unikraft Cloud</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<th scope="row">Gateway</th>
						<td>Worker</td>
						<td>Rust server</td>
					</tr>
					<tr>
						<th scope="row">One root</th>
						<td>One Durable Object</td>
						<td>One actor in the server process</td>
					</tr>
					<tr>
						<th scope="row">Storage</th>
						<td>SQLite, one database per root</td>
						<td>PostgreSQL beside the server, one database per instance</td>
					</tr>
					<tr>
						<th scope="row">Idle cost</th>
						<td>WebSocket hibernation</td>
						<td>Stateful scale-to-zero</td>
					</tr>
					<tr>
						<th scope="row">Placement</th>
						<td>Near the first user of each root</td>
						<td>The metro of the instance</td>
					</tr>
				</tbody>
			</table>
			<p>
				Both backends pass the same conformance suite: same URLs, same errors,
				same live role changes. Switching is a URL change.
			</p>

			<h2>Wire protocol</h2>
			<CodeBlock title="cloud session protocol 1" code={wire} />
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
