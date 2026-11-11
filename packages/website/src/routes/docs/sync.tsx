import { Title } from "@solidjs/meta";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";

const promises = `import { connectPulse, createPulse } from "pulsify-core";

const note = createPulse(Note, data, { connectors: [local, remote] });
const { ready, connected, synced } = connectPulse(note);

await ready;      // usable data (local connectors first)
await connected;  // every connector finished its initial download
await synced;     // every connector acknowledged our local history`;

const offline = `import { connectPulse, createPulse, getPulseMeta } from "pulsify-core";

const note = createPulse(Note, data, {
  connectors: [local, remote],
  onError: (error) => console.warn(error), // once per outage, not per retry
});
connectPulse(note); // from now on, stay synchronized until disconnectPulse

// The network drops: the remote connection retries with backoff, edits continue.
note.tags.push("offline");
getPulseMeta(note).status; // "offline"

// It comes back: a fresh session, a full sync, then "synced" again.`;

const statuses = `idle      not connected: never connected, or disconnectPulse
syncing   connecting, nothing loaded yet
ready     data loaded, some connector not yet synchronized
synced    every connector acknowledged the complete local history
offline   a connector is unreachable and being retried; edits continue
error     a connector stopped on an error a retry cannot fix`;

const statusListener = `import { subscribePulseStatus } from "pulsify-core";

const stop = subscribePulseStatus(note, (status) => {
  banner.hidden = status !== "offline"; // called now, then on every change
});`;

const options = `createPulse(Note, data, {
  connectors: [local, remote],
  reconnect: { initialDelayMs: 250, maxDelayMs: 30_000, factor: 2, jitter: 0.25 }, // defaults
  timeoutMs: 10_000,  // open, request and initial-sync deadline
});

// reconnect: false gives up after the first failure, like a one-shot sync.`;

const events = `import { getPulseMeta, setOnlineMode } from "pulsify-core";

const [connection] = getPulseMeta(note).connections;
connection.on("reconnecting", (error, delayMs, attempt) => {
  showBanner(\`Offline, retry #\${attempt} in \${delayMs} ms\`);
});
connection.on("synced", hideBanner);
connection.status;    // "connecting" | "synced" | "reconnecting" | "error" | …
connection.lastError; // the last failure

setOnlineMode(false); // pause every attempt (airplane mode in your app)
setOnlineMode(true);  // retry now and probe live sessions`;

const manual = `import { connectPulse, disconnectPulse } from "pulsify-core";

disconnectPulse(note);           // stop: no session, no retry, edits continue
note.title = "Offline on purpose";
await connectPulse(note).synced; // missing rows exchanged both ways

// After a FORBIDDEN or an incompatible document, fix the cause, then:
await connectPulse(note).synced; // restarts stopped connectors`;

const batching = `note.title = "A";
note.tags.push("b");
note.author.name = "C";
// One frame per connection, scheduled with queueMicrotask.
// On Cloudflare Workers: await connection.syncBack() or ctx.waitUntil(it).`;

const scopes = `import {
  createMemoryConnector, createPulseScope, loadPulse, PulseRelay,
} from "pulsify-core";

const relay = new PulseRelay();                 // in-memory server
const connector = createMemoryConnector(relay);

const alice = createPulse(Note, { id: "shared", ...data }, {
  scope: createPulseScope(), connectors: [connector],
});
await connectPulse(alice).synced;

const bob = await loadPulse(Note, "shared", {
  scope: createPulseScope(), connectors: [connector], waitFor: "all",
});

alice.title = "From Alice";
bob.title; // "From Alice" after a microtask`;

const custom = `import type { Connector } from "pulsify-core";

const connector: Connector = {
  kind: "remote",
  async open({ docId, signal, onMessage, onClose }) {
    const socket = await openMyTransport(docId, signal);
    socket.onBinary(onMessage);
    socket.onClose(onClose);
    return {
      async send(bytes) { socket.sendBinary(bytes); },
      close() { socket.close(); },
    };
  },
};`;

export default function Sync() {
	return (
		<>
			<Title>Sync and offline · Docs</Title>
			<h1>Sync and offline</h1>
			<p>
				A pulse synchronizes through connectors. Each connector opens one
				session per document and exchanges binary frames. The engine takes care
				of what to send, in which order, and what to do when it comes back.
			</p>

			<h2>Three promises</h2>
			<p>
				<code>connectPulse</code> and <code>loadPulse</code> expose the same
				three milestones. <code>loadPulse</code> waits for <code>ready</code> by
				default; pass <code>waitFor: "synced"</code> or a list of connectors to
				wait for more.
			</p>
			<CodeBlock title="connect.ts" code={promises} />
			<p>
				Missing documents, aborts and timeouts reject with a{" "}
				<code>PulseError</code> carrying a <code>code</code> such as{" "}
				<code>NOT_FOUND</code>. Pass <code>signal</code> to cancel loading.
			</p>

			<h2>Working offline</h2>
			<p>
				There is no offline mode to enable. <code>connectPulse</code> means
				"stay synchronized with every connector, local or remote, until{" "}
				<code>disconnectPulse</code>". Writes always commit locally and the
				exact history is retained; connectors that fail are retried on their
				own.
			</p>
			<CodeBlock title="offline.ts" code={offline} />
			<ul>
				<li>
					<strong>Lost connection.</strong> A closed transport, a failed opening
					or a request without an answer within <code>timeoutMs</code> marks the
					connection as <code>reconnecting</code>. It waits{" "}
					<code>initialDelayMs × factor^n</code>, capped at{" "}
					<code>maxDelayMs</code> and shortened at random by <code>jitter</code>
					, then opens a new session.
				</li>
				<li>
					<strong>Lazy waking.</strong> When the pulse has something to upload
					(a local edit) while a connector is down, that connector retries
					within a second instead of waiting out a long backoff, and at most
					once a second while it stays down. Documents nobody edits keep their
					backoff.
				</li>
				<li>
					<strong>Full resynchronization.</strong> A new session assumes nothing
					about the connector: it sends the local version vector, downloads what
					is missing, then uploads everything the connector does not
					acknowledge. A server restored from an old backup, or one that lost
					its data, gets the complete history back.
				</li>
				<li>
					<strong>Errors that a retry cannot fix</strong> stop that connector:
					authorization (<code>FORBIDDEN</code>), an incompatible document or
					migration, an invalid frame, or an exception in your own code while
					applying received data. The pulse status becomes <code>error</code>{" "}
					and <code>onError</code> receives the cause. Other connectors
					continue.
				</li>
				<li>
					<strong>Local first.</strong> Local connectors are opened before
					remote ones and <code>ready</code> resolves from local data, so an app
					starts offline. A local connector that fails does not block the remote
					ones.
				</li>
				<li>
					<strong>Deadlines.</strong> <code>timeoutMs</code> bounds the promises
					of <code>connectPulse</code> and <code>loadPulse</code>, not the
					intent: after a <code>TIMEOUT</code>, connectors keep retrying.
					Calling <code>connectPulse</code> again returns a new set of promises
					and retries at once.
				</li>
			</ul>

			<h2>Statuses</h2>
			<CodeBlock title="getPulseMeta(note).status" code={statuses} />
			<p>
				Listen instead of polling: the listener runs with the current status,
				then once per change.
			</p>
			<CodeBlock title="banner.ts" code={statusListener} />

			<h2>Tuning and observing</h2>
			<CodeBlock title="options.ts" code={options} />
			<p>
				In a browser, the <code>online</code> event retries waiting connections
				at once and probes established ones, which catches sockets that died
				during sleep. While <code>navigator.onLine</code> is false, attempts
				wait for that event. Between those events, detecting a transport that
				died without closing is the connector's job, once per socket: the{" "}
				<a href="/docs/cloud">cloud connector</a> pings each idle socket, and
				local connectors cannot die silently.
			</p>
			<CodeBlock title="connection.ts" code={events} />

			<h2>Disconnect on purpose</h2>
			<CodeBlock title="manual.ts" code={manual} />
			<Note>
				A pulse lives in memory. To keep offline edits across reloads and
				restarts, add a <a href="/docs/local-persistence">local connector</a>:
				IndexedDB in browsers, SQLite in Electron or Tauri.
			</Note>

			<h2>Automatic batching</h2>
			<p>
				Writes commit immediately and locally. Uploads are coalesced per
				connection and per microtask, so a burst of edits costs one frame. Large
				batches split at protocol limits.
			</p>
			<CodeBlock title="batch.ts" code={batching} />

			<h2>Scopes for tests</h2>
			<p>
				A scope holds one instance per document ID. Use separate scopes to
				simulate several clients in one process, which makes collaboration tests
				trivial.
			</p>
			<CodeBlock title="two-clients.test.ts" code={scopes} />

			<h2>Custom transports</h2>
			<p>
				A connector is a tiny interface. Anything that moves complete binary
				frames works: WebSocket, WebTransport, BroadcastChannel, a native
				bridge.
			</p>
			<CodeBlock title="connector.ts" code={custom} />

			<h2>Protocol versions</h2>
			<p>
				The WebSocket connector speaks envelope 1 by default. Against a server
				that negotiates <code>pulsify-v3</code>, pass{" "}
				<code>{`{ protocolVersion: 3 }`}</code> to enable grouped scalar runs
				and condensed state downloads. The server always stores exact history.
			</p>

			<Note>
				Destroy what you no longer display: <code>destroyPulse(note)</code>{" "}
				closes sessions, cancels pending loads and frees the identity map entry.
				It does not delete anything on the relay.
			</Note>
		</>
	);
}
