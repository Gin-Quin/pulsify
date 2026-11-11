# pulsify-tauri

Local persistence for Pulsify documents in [Tauri 2](https://v2.tauri.app) apps:
a **Rust SQLite store** in the app process and a `local` connector for the
webview.

- **Local first:** documents load from disk before the network answers, and edits made offline are stored immediately.
- **One writer:** every window shares one SQLite connection; rows saved by one window reach the others live.
- **Reused actor IDs:** a window takes over the [actor ID](../../pulse/README.md#actor-ids) of a closed one (`actorPool: "tauri:<plugin>"`), so restarts do not add actors to a document.
- **Same file format** as the TypeScript `SqlitePatchStore`: either side can open a database written by the other.
- **Binary IPC:** frames travel as raw bytes (`tauri::ipc::Request`/`Channel`), never as JSON arrays.

| Part | Contents |
| --- | --- |
| `pulsify-tauri` | `createTauriConnector()` for the webview |
| [`crates/tauri-plugin-pulsify`](crates/tauri-plugin-pulsify) | Tauri plugin: `open`, `send` and `close` commands, one `Channel` per session |
| [`crates/pulsify-sqlite`](crates/pulsify-sqlite) | Tauri-free library: `SqliteStore`, `relay_frame` and the session `Hub` |

## Setup

```toml
# src-tauri/Cargo.toml
[dependencies]
tauri-plugin-pulsify = "6"
```

```rust
// src-tauri/src/lib.rs
tauri::Builder::default()
    .plugin(tauri_plugin_pulsify::init())
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
```

Grant the commands to your windows in a capability:

```json
// src-tauri/capabilities/default.json
{
  "identifier": "default",
  "windows": ["main"],
  "permissions": ["core:default", "pulsify:default"]
}
```

`pulsify:default` allows `open`, `send` and `close`; `pulsify:allow-open`, …
grant them one by one. Without it, `open()` fails with `FORBIDDEN`.

## Usage

```ts
import { createTauriConnector } from "pulsify-tauri";
import { createWebSocketConnector, loadPulse } from "pulsify-core";

const local = createTauriConnector();
const remote = createWebSocketConnector("wss://sync.example.com/{docId}");

const notebook = await loadPulse(Notebook, userId, {
  connectors: [local, remote],
  include: true,
});
```

`connectPulse` synchronizes `local` connectors before `remote` ones, so a
document opens from disk, then exchanges the missing rows with the server. Each
reconnection opens a new session and performs a fresh synchronization.

| Option | Default |
| --- | --- |
| `invoke` | `invoke` from `@tauri-apps/api/core` |
| `createChannel` | `(onMessage) => new Channel(onMessage)` |
| `plugin` | `"pulsify"`, the name the plugin was registered under |

Plugin errors arrive as `PulseError`s with the store's code (`CONFLICT`,
`LIMIT_EXCEEDED`, `INVALID_MESSAGE`, …). An unknown session or a failing IPC
call closes the connection with `CLOSED` or `CONNECTION_FAILED`, which the core
retries.

## Window presence

Remote connectors such as `pulsify-cloud` ping their sockets in the background
only while someone uses the app. WebView2 (Windows) never tells the page that
its window is minimized, so forward the native window state:

```ts
import { presence } from "pulsify-cloud";
import { watchTauriPresence } from "pulsify-tauri";

const stop = await watchTauriPresence(presence); // any { set(present) }
```

A minimized or hidden window calls `presence.set(false)`; a restored, shown or
focused one calls `presence.set(true)`. Every cloud connector of the page
shares this `presence` unless given its own. It uses `isMinimized`, `isVisible`,
`onResized` and `onFocusChanged` from `@tauri-apps/api/window`, so the
capability needs `core:window:default` (included in `core:default`).

## Database

The default file is `pulsify.sqlite` in the
[app data directory](https://docs.rs/tauri/2/tauri/path/struct.PathResolver.html#method.app_data_dir),
opened in WAL mode with `synchronous=FULL`: rows are durable before they are
acknowledged. It opens on the first `open` call: if it cannot be opened (full
disk, permissions), the app still starts, sessions fail with
`CONNECTION_FAILED`, and connected pulses retry until it works. Choose another
location with the builder; relative paths resolve
against the app data directory.

```rust
.plugin(tauri_plugin_pulsify::Builder::new().path("documents/pulsify.sqlite").build())
```

The file uses `SQLITE_PATCH_SCHEMA` and the append rules of `SqlitePatchStore`
(`pulsify-core/storage`): immutable rows keyed by document, actor and clock,
idempotent retransmissions, `CONFLICT` for changed bytes or forked histories,
rows pending until their causal history is complete. Copy it to a server and
serve it with `relayStoreMessage`, or read it from Bun with `bun:sqlite`:

```ts
import { Database } from "bun:sqlite";
import { SqlitePatchStore } from "pulsify-core/storage";

const store = new SqlitePatchStore(new Database("pulsify.sqlite"));
const rows = await store.missing("notes/1", []);
```

From Rust, the managed `tauri_plugin_pulsify::Pulsify` state gives exclusive
access to the store (`with_store`, which opens it if needed and returns a
`Result`), for backups or maintenance.

## Tests

```sh
bun test packages/connectors/Tauri/tests
cargo test --manifest-path packages/connectors/Tauri/crates/pulsify-sqlite/Cargo.toml
cargo test --manifest-path packages/connectors/Tauri/crates/tauri-plugin-pulsify/Cargo.toml
```

The Bun suite builds the `pulsify-sqlite` test harness and drives real
documents through the connector against the Rust hub: restarts, rich text,
arrays, sub-pulses, live broadcasts, and files exchanged in both directions
with `SqlitePatchStore`. It skips the Rust part when `cargo` is not installed.
The plugin crate runs its commands on Tauri's mock runtime.
