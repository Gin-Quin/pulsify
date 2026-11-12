import { Title } from "@solidjs/meta";
import { For } from "solid-js";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";

type Row = [name: string, text: string];

function Rows(props: { rows: Row[] }) {
	return (
		<table>
			<tbody>
				<For each={props.rows}>
					{([name, text]) => (
						<tr>
							<th scope="row">
								<code>{name}</code>
							</th>
							<td>{text}</td>
						</tr>
					)}
				</For>
			</tbody>
		</table>
	);
}

const create = `import { createPulse } from "pulsify-core";

const note = createPulse(Note, {
  title: "Draft",
  tags: [],
  author: { name: "Ada" },
}, {
  connectors: [local, remote],
  connect: true, // start synchronizing now
});

note.id;      // generated with crypto.randomUUID(), or the id you passed in the data
note.kind;    // "Note"
note.version; // schema version, starting at 1`;

const load = `import { loadPulse } from "pulsify-core";

const note = await loadPulse(Note, "note-42", { connectors: [local, remote] });

// Wait for more than usable data, give up after 3 seconds, allow cancelling.
const controller = new AbortController();
const fresh = await loadPulse(Note, "note-42", {
  connectors: [local, remote],
  waitFor: "synced",
  timeoutMs: 3_000,
  signal: controller.signal,
});`;

const subscribe = `import { snapshotPulse, subscribePulse, subscribePulseStatus } from "pulsify-core";

const stop = subscribePulse(note, (note) => {
  render(note.title, note.tags); // now, then after every local or remote change
});

const stopStatus = subscribePulseStatus(note, (status) => {
  banner.hidden = status !== "offline"; // now, then on every status change
});

const plain = snapshotPulse(note); // detached copy, safe to store or send

stop();
stopStatus();`;

const edit = `import { arrayOperations } from "pulsify-core";

note.title = "Ready";          // assign
note.author.name = "Grace";    // nested
note.tags.push("review");      // native array methods

const tags = arrayOperations(note.tags);
tags.insert(0, ["urgent"]);
tags.move(0, 2);               // keeps the element identity, unlike delete + insert
tags.delete(1, 1);
tags.replaceAll(["a", "b"]);`;

const lifecycle = `import { connectPulse, destroyPulse, disconnectPulse } from "pulsify-core";

const { ready, connected, synced } = connectPulse(note);
await synced;

disconnectPulse(note); // no session, no retry; the pulse stays editable
connectPulse(note);    // back online, missing rows exchanged both ways

destroyPulse(note);    // when nothing displays it anymore`;

const children = `import { createPulse, loadPulse, pulseRef } from "pulsify-core";

const project = createPulse(Project, { name: "Engine", documents: [] }, { parent: user });
project.id;                            // "<user id>/<generated>"
user.projects.push(pulseRef(project)); // link it from its parent

const ref = user.projects[0];
ref.id;              // the stored ID
ref.pulse;           // the loaded instance, or undefined
await ref.load();    // loadPulse with the parent's scope and connectors

// A parent loads with all its sub-pulses, recursively, unless told otherwise.
await loadPulse(User, "1234");
const lazy = await loadPulse(User, "1234", { subPulses: false });
await Promise.all(lazy.projects.map((ref) => ref.load({ subPulses: false }))); // one level`;

const defaults = `import { setDefaultPulseOptions } from "pulsify-core";

// Once, at startup: every pulse created or loaded afterwards inherits these.
setDefaultPulseOptions({
  connectors: [local, remote],
  timeoutMs: 5_000,
  onError: (error) => reportToMonitoring(error), // global error handler
});

const note = await loadPulse(Note, "note-42"); // no options needed anymore`;

const online = `import { isOnline, isOnlineMode, onOnline, setOnlineMode } from "pulsify-core";

setOnlineMode(false); // pause every reconnection attempt of every pulse
setOnlineMode(true);  // resume and retry now

isOnlineMode(); // what you set
isOnline();     // what you set, and navigator.onLine in a browser

const stop = onOnline(() => hideOfflineBanner()); // the network may be back`;

const connections = `import { getPulseMeta } from "pulsify-core";

const meta = getPulseMeta(note);
meta.status;    // "idle" | "syncing" | "ready" | "synced" | "offline" | "error"
meta.lastError; // the last error reported for this pulse

const [connection] = meta.connections; // one per connector, in the same order
const stop = connection.on("reconnecting", (error, delayMs, attempt) => {
  showBanner("Offline, retry " + attempt + " in " + delayMs + " ms");
});
connection.once("synced", hideBanner);
connection.status;    // "connecting" | "synced" | "reconnecting" | "error" | …
connection.lastError;
await connection.whenSynced; // the next complete upload to that connector`;

const errors = `import { isRetryable, loadPulse, PulseError } from "pulsify-core";

try {
  await loadPulse(Note, id, { connectors: [remote] });
} catch (error) {
  if (!(error instanceof PulseError)) throw error;
  if (error.code === "NOT_FOUND") return createNote(id);
  if (isRetryable(error)) return showRetryLater(); // CLOSED, CONNECTION_FAILED, TIMEOUT
  throw error;
}`;

export default function PulseMethods() {
	return (
		<>
			<Title>Pulse methods · Docs</Title>
			<h1>Pulse methods</h1>
			<p>
				A pulse has no methods of its own: its properties are your data. Every
				operation is a function that takes the pulse, imported from{" "}
				<code>pulsify-core</code>. This page lists the ones an application uses,
				from creating a pulse to the global handlers. Server and protocol
				exports are in the <a href="/docs/api">API cheat sheet</a>.
			</p>

			<h2>Create and load</h2>

			<h3>createPulse(definition, data, options?)</h3>
			<p>
				Creates a new document and returns it synchronously. The data must match
				the latest schema of the definition; <code>id</code> is optional and{" "}
				<code>kind</code> and <code>version</code> are managed by Pulsify. When
				the scope already holds a pulse with that ID, that instance is returned
				and the data is ignored.
			</p>
			<CodeBlock title="create.ts" code={create} />

			<h3>loadPulse(definition, id, options?)</h3>
			<p>
				Opens an existing document and resolves once usable data is available,
				from local connectors first. An instance already loaded in the scope is
				returned at once. It rejects with a <code>PulseError</code>:{" "}
				<code>NOT_FOUND</code> when no connector has the document,{" "}
				<code>TIMEOUT</code> after <code>timeoutMs</code>, <code>CLOSED</code>{" "}
				when aborted.
			</p>
			<CodeBlock title="load.ts" code={load} />
			<Rows
				rows={[
					[
						"waitFor",
						'"ready" (default): usable data. "connected": every connector downloaded. "synced" or "all": every connector acknowledged the local history. A list of connectors: those are synced.',
					],
					[
						"subPulses",
						"Sub-pulses loaded with the pulse: true (default) for all of them, recursively; false for none, then ref.load() loads the ones you need. A child that does not exist yet is skipped: its ref.pulse stays undefined. setDefaultPulseOptions({ subPulses: false }) makes every load lazy.",
					],
					["signal", "An AbortSignal that cancels the load."],
					["timeoutMs", "Deadline of this load. Default 10 000."],
				]}
			/>

			<h3>Options</h3>
			<p>
				Both functions accept these, and{" "}
				<a href="#global-defaults">
					<code>setDefaultPulseOptions</code>
				</a>{" "}
				sets them for the whole application.
			</p>
			<Rows
				rows={[
					[
						"connectors",
						"Where the pulse is stored and synchronized. Local connectors are opened first. Default: none.",
					],
					[
						"connect",
						"createPulse only: start synchronizing at creation instead of waiting for connectPulse. Default false. loadPulse always connects.",
					],
					[
						"scope",
						"The identity map holding one instance per ID. Default: one shared scope. See createPulseScope.",
					],
					[
						"timeoutMs",
						"Deadline of the initial synchronization, of opening a transport and of each request. Default 10 000.",
					],
					[
						"reconnect",
						"Backoff of a failing connector: { initialDelayMs: 250, maxDelayMs: 30 000, factor: 2, jitter: 0.25 }. false gives up after the first failure.",
					],
					[
						"onError",
						"Called with every error the pulse cannot throw at you: see the global error handler below.",
					],
					[
						"createId",
						"Generates the ID of a pulse created without one. Default crypto.randomUUID().",
					],
					[
						"parent",
						"createPulse only: create a sub-pulse of that pulse. The ID is prefixed by the parent's and its options are inherited.",
					],
				]}
			/>

			<h2>Read and observe</h2>
			<p>
				Reading a property returns the current value; nothing is asynchronous
				once the pulse is loaded. Framework bindings subscribe for you: see the{" "}
				<a href="/docs/frontend/svelte">Frontend</a> pages.
			</p>
			<CodeBlock title="observe.ts" code={subscribe} />
			<Rows
				rows={[
					[
						"subscribePulse(pulse, listener)",
						"Calls listener(pulse) now, then synchronously after every local or remote change. Returns a function that unsubscribes.",
					],
					[
						"subscribePulseStatus(pulse, listener)",
						"Calls listener(status, pulse) now, then on every change of the synchronization status. Returns a function that unsubscribes.",
					],
					[
						"snapshotPulse(pulse)",
						"A detached plain copy of the materialized pulse. Rich text becomes a string and a sub-pulse its ID.",
					],
					[
						"isPulseLoaded(pulse)",
						"Whether the pulse has data. False for an instance whose load is still in flight.",
					],
					[
						"hasPulseLatestVersion(pulse)",
						"Whether the pulse is loaded and at the latest schema version of its definition.",
					],
					[
						"getPulseMeta(pulse)",
						"The status, the last error and the connections of the pulse.",
					],
				]}
			/>
			<Note>
				Subscribing to a destroyed pulse throws <code>CLOSED</code>. An
				exception thrown by a listener during its first, immediate call reaches
				the caller; later ones go to <code>onError</code>, so one failing
				listener never blocks the others.
			</Note>

			<h2>Edit</h2>
			<p>
				There is no setter function: write to the pulse as to a plain object.
				Each write is validated against the schema, committed, and announced to
				subscribers before the assignment returns. <code>arrayOperations</code>{" "}
				adds the operations native arrays lack. See{" "}
				<a href="/docs/values">Values</a> for rich text and trees.
			</p>
			<CodeBlock title="edit.ts" code={edit} />

			<h2>Connect, disconnect and destroy</h2>
			<CodeBlock title="lifecycle.ts" code={lifecycle} />
			<Rows
				rows={[
					[
						"connectPulse(pulse, options?)",
						"Stay synchronized with every connector until disconnectPulse. Returns three promises: ready, connected and synced. Options: signal and timeoutMs. Calling it again retries failing connectors now.",
					],
					[
						"disconnectPulse(pulse)",
						"Close every session and stop retrying. The pulse stays loaded and editable; its status becomes idle.",
					],
					[
						"destroyPulse(pulse)",
						"Disconnect, remove every subscription and release the instance from its scope. Nothing is deleted on the server.",
					],
				]}
			/>
			<p>
				<a href="/docs/sync">Sync and offline</a> describes the three promises,
				the statuses and reconnection in detail.
			</p>

			<h2>Sub-pulses</h2>
			<p>
				A <code>sub(Definition)</code> field holds the ID of a child pulse: a
				separate document that loads and synchronizes on its own. Reading the
				field returns a reference.
			</p>
			<CodeBlock title="children.ts" code={children} />
			<Rows
				rows={[
					[
						"pulseRef(pulse)",
						"A reference to an existing pulse, assignable to a sub() field.",
					],
					[
						"ref.load(options?)",
						"loadPulse for that child, with the scope and connectors of its parent.",
					],
					[
						"ref.pulse",
						"The child instance when it is loaded in the parent's scope, undefined otherwise.",
					],
				]}
			/>

			<h2 id="global-defaults">Global defaults and error handler</h2>
			<p>
				<code>setDefaultPulseOptions</code> merges its argument into the
				defaults of every pulse created or loaded afterwards. Options passed to{" "}
				<code>createPulse</code> or <code>loadPulse</code> win over them, one by
				one: a pulse with its own <code>onError</code> no longer calls the
				global one.
			</p>
			<CodeBlock title="main.ts" code={defaults} />
			<p>
				<code>onError</code> is the one place where errors that have no caller
				arrive. It receives:
			</p>
			<ul>
				<li>
					connection failures, once per outage and not once per retry, and
					errors that stop a connector such as <code>FORBIDDEN</code>;
				</li>
				<li>
					a connection attempt that failed or was cancelled, in addition to the
					rejected promise;
				</li>
				<li>
					exceptions thrown by your own subscribers and connection listeners.
				</li>
			</ul>
			<p>
				The last error is also kept in{" "}
				<code>getPulseMeta(pulse).lastError</code>. An exception thrown by{" "}
				<code>onError</code> itself is ignored.
			</p>

			<h3>createPulseScope()</h3>
			<p>
				A scope holds one instance per document ID, which is why loading the
				same ID twice gives the same object. Applications use the default one.
				Pass a new scope as the <code>scope</code> option to keep instances
				apart: several clients in one test, or several accounts in one page.
			</p>

			<h2>Network state</h2>
			<p>
				These functions are global: they apply to every pulse of the page. In a
				browser, Pulsify already follows <code>navigator.onLine</code> and the{" "}
				<code>online</code> event; <code>setOnlineMode</code> is for an offline
				switch of your own.
			</p>
			<CodeBlock title="network.ts" code={online} />
			<Rows
				rows={[
					[
						"setOnlineMode(online)",
						"false pauses the reconnection attempts of every pulse; true resumes them and retries at once. Edits continue either way.",
					],
					["isOnlineMode()", "The value given to setOnlineMode. Default true."],
					[
						"isOnline()",
						"Whether attempts may run: the online mode and, in a browser, navigator.onLine. Always true elsewhere unless the online mode is off.",
					],
					[
						"onOnline(listener)",
						"Calls listener when the network may be back: the browser's online event, or setOnlineMode(true). Returns a function that unsubscribes.",
					],
				]}
			/>

			<h2>Connection listeners</h2>
			<p>
				A pulse has one connection per connector. Listen to one of them to
				follow a single connector, for example the remote one, instead of the
				overall status.
			</p>
			<CodeBlock title="connection.ts" code={connections} />
			<Rows
				rows={[
					["connecting", "An attempt starts."],
					[
						"connected",
						"The initial download from that connector is complete.",
					],
					["synced", "The connector acknowledged the complete local history."],
					[
						"reconnecting",
						"A retryable failure: (error, delayMs, attempt). The next attempt starts after delayMs.",
					],
					["error", "Every failure, retryable or not: (error)."],
					["closing, closed", "The session is being closed, then is closed."],
				]}
			/>
			<p>
				<code>on</code> and <code>once</code> return a function that removes the
				listener; <code>off(event, listener)</code> does the same.
			</p>

			<h2>Errors</h2>
			<p>
				Every error raised by Pulsify is a <code>PulseError</code> with a{" "}
				<code>code</code>. <code>isRetryable(error)</code> tells transport
				failures, which a connected pulse retries on its own, from errors that
				need a fix.
			</p>
			<CodeBlock title="errors.ts" code={errors} />
			<Rows
				rows={[
					["NOT_FOUND", "No connector has a document with that ID."],
					["TIMEOUT", "No answer within timeoutMs. Retried."],
					["CONNECTION_FAILED", "The transport could not be opened. Retried."],
					[
						"CLOSED",
						"The transport closed, the operation was aborted, or the pulse is disconnected or destroyed. Retried when it comes from the transport.",
					],
					["FORBIDDEN", "The server refused the session or the write."],
					[
						"INCOMPATIBLE_DOCUMENT",
						"The ID belongs to a pulse of another definition.",
					],
					[
						"MIGRATION_DRIFT",
						"The stored schema chain does not match the definition. Thrown as MigrationDriftError, with details.",
					],
					[
						"LIMIT_EXCEEDED",
						"A protocol limit was reached, such as frame size.",
					],
					[
						"UNSUPPORTED_VERSION, INVALID_MESSAGE, CONFLICT, HISTORY_UNAVAILABLE",
						"Protocol errors: a peer of an unsupported version, a malformed frame, two different writes under the same operation ID, or a peer that cannot provide the requested history.",
					],
				]}
			/>
		</>
	);
}
