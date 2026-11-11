# tauri-plugin-pulsify

Local persistence for [Pulsify](https://www.npmjs.com/package/pulsify-core)
documents in Tauri 2 apps, desktop and mobile. The plugin keeps a SQLite
database in the app process; the webview talks to it through the `local`
connector of the [`pulsify-tauri`](https://www.npmjs.com/package/pulsify-tauri)
npm package.

- **Local first:** documents load from disk before the network answers, and edits made offline are stored immediately.
- **One writer:** every window shares one SQLite connection; rows saved by one window reach the others live.
- **Same file format** as the TypeScript `SqlitePatchStore`: either side can open a database written by the other.
- **Binary IPC:** frames travel as raw bytes (`tauri::ipc::Request`/`Channel`), never as JSON arrays.

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
grant them one by one.

In the webview:

```ts
import { createTauriConnector } from "pulsify-tauri";
import { loadPulse } from "pulsify-core";

const notebook = await loadPulse(Notebook, userId, {
  connectors: [createTauriConnector(), remote],
  include: true,
});
```

## Database

The default file is `pulsify.sqlite` in the app data directory, opened in WAL
mode with `synchronous=FULL`: rows are durable before they are acknowledged.
Choose another file with the builder:

```rust
tauri_plugin_pulsify::Builder::new().path("/path/to/notes.sqlite").build()
```

The store itself, without Tauri, is the
[`pulsify-sqlite`](https://crates.io/crates/pulsify-sqlite) crate.

## License

Apache-2.0
