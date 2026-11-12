import { Title } from "@solidjs/meta";
import { CodeBlock } from "~/components/CodeBlock";
import { Note } from "~/components/DocsLayout";
import { Tabs } from "~/components/Tabs";

const pattern = `const note = await loadPulse(Note, id, {
  connectors: [local, remote], // local first: ready from disk, then synced with the server
});`;

const indexeddb = `// bun add pulsify-indexeddb
import { createWebSocketConnector, loadPulse } from "pulsify-core";
import { createIndexedDbConnector } from "pulsify-indexeddb";

const local = createIndexedDbConnector({ name: \`my-app:\${user.id}\` }); // one database per account
const remote = createWebSocketConnector("wss://example.com/sync?doc={docId}");

const note = await loadPulse(Note, noteId, { connectors: [local, remote] });

// On logout: stop the pulses, then wipe and close.
destroyPulse(note);
await local.clear();
local.close(); // pulses using it stop instead of reconnecting`;

const electronMain = `// main.ts (bun add pulsify-electron better-sqlite3, then rebuild it for Electron)
import { app, ipcMain } from "electron";
import { join } from "node:path";
import { servePulsifyStore } from "pulsify-electron/main";

const store = servePulsifyStore({
  ipcMain,
  database: join(app.getPath("userData"), "pulsify.sqlite"), // WAL, one file for every window
});
app.on("will-quit", () => void store.close());

// preload.ts
import { contextBridge, ipcRenderer } from "electron";
import { exposePulsifyBridge } from "pulsify-electron";
exposePulsifyBridge({ contextBridge, ipcRenderer }); // window.pulsify, frames only`;

const electronRenderer = `// renderer.ts
import { createElectronConnector } from "pulsify-electron";

const local = createElectronConnector();
const notebook = await loadPulse(Notebook, "notebook", {
  connectors: [local, remote],
});`;

const tauriRust = `# src-tauri/Cargo.toml
[dependencies]
tauri-plugin-pulsify = "6"

// src-tauri/src/lib.rs
tauri::Builder::default()
    .plugin(tauri_plugin_pulsify::init()) // pulsify.sqlite in the app data directory
    .run(tauri::generate_context!())
    .expect("error while running tauri application");

// src-tauri/capabilities/default.json
{ "identifier": "default", "windows": ["main"], "permissions": ["core:default", "pulsify:default"] }`;

const tauriWebview = `// bun add pulsify-tauri @tauri-apps/api
import { createTauriConnector } from "pulsify-tauri";

const local = createTauriConnector();
const notebook = await loadPulse(Notebook, userId, {
  connectors: [local, remote],
});`;

const cloud = `import { createCloudConnector } from "pulsify-cloud";
import { createIndexedDbConnector } from "pulsify-indexeddb";

const local = createIndexedDbConnector({ name: \`notes:\${user.id}\` });
const cloud = createCloudConnector({ url: PULSIFY_URL, token: fetchToken });

const notebook = await loadPulse(Notebook, user.id, {
  connectors: [local, cloud],
});`;

export default function LocalPersistence() {
	return (
		<>
			<Title>Local persistence · Docs</Title>
			<h1>Local persistence</h1>
			<p>
				A pulse lives in memory. A <strong>local connector</strong> stores its
				history on the device, so documents open without a network, offline
				edits survive reloads and restarts, and everything uploads once a remote
				connector is reachable again.
			</p>
			<CodeBlock title="pattern.ts" code={pattern} />
			<ul>
				<li>
					<strong>Local first.</strong> Local connectors are opened before
					remote ones and <code>ready</code> resolves from disk.
				</li>
				<li>
					<strong>Everything is stored.</strong> Local edits and rows received
					from the server are written, acknowledged only after the transaction
					commits.
				</li>
				<li>
					<strong>Same rules as the server.</strong> Each store keeps immutable
					operation rows with the semantics of a server store: duplicates are
					idempotent, conflicts roll back, rows wait for their dependencies.
				</li>
				<li>
					<strong>Self-healing.</strong> A local store that fails (blocked
					storage, closed database, restarted main process) is retried like any
					connector, with a full resynchronization.
				</li>
			</ul>

			<h2>Pick a store</h2>
			<table>
				<thead>
					<tr>
						<th>Package</th>
						<th>Runtime</th>
						<th>Storage</th>
						<th>Several windows</th>
					</tr>
				</thead>
				<tbody>
					<tr>
						<td>
							<code>pulsify-indexeddb</code>
						</td>
						<td>Browsers, PWAs</td>
						<td>IndexedDB, one database per name</td>
						<td>Tabs updated through a BroadcastChannel</td>
					</tr>
					<tr>
						<td>
							<code>pulsify-electron</code>
						</td>
						<td>Electron</td>
						<td>SQLite (better-sqlite3) in the main process</td>
						<td>Every window updated by the main process</td>
					</tr>
					<tr>
						<td>
							<code>pulsify-tauri</code>
						</td>
						<td>Tauri 2</td>
						<td>SQLite (rusqlite) in the Rust core</td>
						<td>Every webview updated by the Rust core</td>
					</tr>
				</tbody>
			</table>

			<h2>Browsers: IndexedDB</h2>
			<CodeBlock title="app.ts" code={indexeddb} />
			<p>
				A blocked or full storage fails with <code>CONNECTION_FAILED</code> or{" "}
				<code>LIMIT_EXCEEDED</code>; the document keeps working from memory and
				the remote meanwhile.
			</p>

			<h2>Electron: SQLite in the main process</h2>
			<p>
				better-sqlite3 runs in the main process; windows talk to it over IPC
				with binary frames, through a bridge that exposes nothing else.
			</p>
			<Tabs
				tabs={[
					{
						label: "Main and preload",
						content: <CodeBlock title="main.ts" code={electronMain} />,
					},
					{
						label: "Renderer",
						content: <CodeBlock title="renderer.ts" code={electronRenderer} />,
					},
				]}
			/>
			<p>
				The SQLite file uses the same schema as <code>SqlitePatchStore</code>,
				so any Pulsify SQLite tool can read it.
			</p>

			<h2>Tauri: SQLite in the Rust core</h2>
			<p>
				A Tauri 2 plugin stores documents with rusqlite and streams frames to
				each webview as raw bytes over a Tauri channel. The file format is the
				same as <code>SqlitePatchStore</code>: TypeScript and Rust read each
				other's databases.
			</p>
			<Tabs
				tabs={[
					{
						label: "Rust",
						content: <CodeBlock title="src-tauri" code={tauriRust} />,
					},
					{
						label: "Webview",
						content: <CodeBlock title="app.ts" code={tauriWebview} />,
					},
				]}
			/>
			<p>
				The database opens on first use: if it cannot be opened, the app still
				starts and connected pulses retry. Without the{" "}
				<code>pulsify:default</code> permission, loading fails with{" "}
				<code>FORBIDDEN</code>.
			</p>

			<h2>With Pulsify Cloud</h2>
			<p>
				Local connectors combine with any remote, including the cloud: the
				notebook opens offline, and the cloud socket catches up in the
				background.
			</p>
			<CodeBlock title="notebook.ts" code={cloud} />
			<Note kind="warn">
				A local store keeps the full history and never compacts it. Use one
				database per account and wipe it on logout.
			</Note>
		</>
	);
}
