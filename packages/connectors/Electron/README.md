# pulsify-electron

Local persistence for Pulsify documents in Electron apps. One SQLite file
lives in the main process (better-sqlite3); every renderer window talks to it
over IPC with binary Pulsify frames.

- **Local first:** documents load from disk instantly and offline; add a
  remote connector to sync when the network is there.
- **Every window in sync:** an edit stored by one window is pushed to every
  other window that has the same document open.
- **Reused actor IDs:** a window takes over the
  [actor ID](../../pulse/README.md#actor-ids) of a closed one
  (`actorPool: "electron:<bridge key>"`), so restarts do not add actors to a
  document.
- **Durable:** rows are committed (WAL) before they are acknowledged.
- **Safe bridge:** the page only gets `open`, `send`, `close` and two
  listeners, never `ipcRenderer`.

```sh
bun add pulsify-core pulsify-electron better-sqlite3
npx @electron/rebuild -f -w better-sqlite3   # or electron-builder's install-app-deps
```

better-sqlite3 is a native module: it must be built for Electron's Node ABI,
not your system Node. `@electron/rebuild` (or `electron-builder install-app-deps`,
or Electron Forge's rebuild hook) downloads a matching prebuild when one exists
and compiles it otherwise. Keep it unpacked from the asar archive
(`asarUnpack: ["**/*.node"]`).

## Main process

```ts
import { app, ipcMain } from "electron";
import { join } from "node:path";
import { servePulsifyStore } from "pulsify-electron/main";

const store = servePulsifyStore({
  ipcMain,
  database: join(app.getPath("userData"), "pulsify.sqlite"),
});
app.on("will-quit", () => void store.close());
```

`pulsify-electron/main` is the only entry that loads better-sqlite3. Renderer
and preload code import `pulsify-electron`, which bundles for the web without
pulling in Node modules.

Given a path, the store opens the file with WAL and a 5 s busy timeout, and
`close()` closes it. You can also pass an open better-sqlite3 `Database`; it
stays yours (configure `db.pragma("journal_mode = WAL")` yourself) and is
left open by `close()`. `store.ready` rejects if the database cannot be opened;
renderers then fail to connect with `CONNECTION_FAILED` and retry.

## Preload

```ts
import { contextBridge, ipcRenderer } from "electron";
import { exposePulsifyBridge } from "pulsify-electron";

exposePulsifyBridge({ contextBridge, ipcRenderer }); // window.pulsify
```

This needs `contextIsolation: true` (Electron's default). Bundle the preload
script (sandboxed preloads can only `require("electron")`). Without context
isolation, assign `window.pulsify = createPulsifyBridge(ipcRenderer)` instead,
and only for trusted content. The `key` and `channel` options rename the
global and the IPC channels; the channel must match `servePulsifyStore`.

## Renderer

```ts
import { createElectronConnector } from "pulsify-electron";
import { createWebSocketConnector, loadPulse } from "pulsify-core";

const local = createElectronConnector(); // reads window.pulsify
const remote = createWebSocketConnector("wss://sync.example.com/{docId}");

const notebook = await loadPulse(Notebook, "notebook", {
  connectors: [local, remote],
  include: true,
});
```

The connector has `kind: "local"`: Pulsify loads from disk first, resolves
`ready` without waiting for the network, then syncs both ways with the remote
whenever it is reachable. Edits made offline are stored locally and uploaded
on the next connection; remote edits are written to disk as they arrive.
Use `createElectronConnector()` alone for a purely local app.

If the main process is unreachable, `open()` rejects with `CONNECTION_FAILED`.
Sessions closed on the main side (store closed, window reloaded or destroyed)
end with `CLOSED`, and `connectPulse` reconnects with a fresh sync.

## Data

Rows are stored by `SqlitePatchStore` (see [docs/STORAGE.md](../../../docs/STORAGE.md)):
the file is readable by any SQLite driver and by Pulsify servers using the
same schema. The default location above is the per-user app data folder
(`~/Library/Application Support/<app>` on macOS, `%APPDATA%\<app>` on Windows,
`~/.config/<app>` on Linux).

To wipe everything, close the store and delete `pulsify.sqlite` with its
`-wal` and `-shm` files. To forget one document, close the windows using it,
then in the main process:

```ts
db.prepare("DELETE FROM pulsify_op_rows WHERE doc_id = ?").run(docId);
db.prepare("DELETE FROM pulsify_doc_clocks WHERE doc_id = ?").run(docId);
```

## Tests

```sh
bun test packages/connectors/Electron/tests
```

The suite runs real documents and better-sqlite3 through an in-memory fake of
`ipcMain`, `ipcRenderer`, `contextBridge` and several windows: restarts,
cross-window broadcasts, reloads, offline-first sync with a remote relay,
store conflicts and file interoperability with `bun:sqlite`.
