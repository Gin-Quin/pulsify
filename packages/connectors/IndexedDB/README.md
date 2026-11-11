# pulsify-indexeddb

Local persistence for Pulsify documents in the browser's IndexedDB. Documents
open from disk without a network, edits made offline survive reloads, and they
upload once a remote connector is reachable.

```sh
npm install pulsify-core pulsify-indexeddb
```

Use it as a `local` connector next to a remote one. Pulsify connects local
connectors first, so a document is ready as soon as IndexedDB has it:

```ts
import { createWebSocketConnector, loadPulse } from "pulsify-core";
import { createIndexedDbConnector } from "pulsify-indexeddb";

const local = createIndexedDbConnector({ name: "my-app" });
const remote = createWebSocketConnector("wss://example.com/pulsify");

const note = await loadPulse(Note, noteId, { connectors: [local, remote] });
```

Every edit is written to IndexedDB, and so is every update received from the
remote. A frame is acknowledged only after its transaction committed. When
another session of the same document writes, the connector forwards the new rows
to the other pulses on that document, in this tab and in other tabs of the same
origin (through a `BroadcastChannel` named after the database).

## What is stored

The connector stores the operation history, not snapshots, with the same rules
as `SqlitePatchStore` from `pulsify-core/storage`:

- `rows`: immutable segments keyed by `[docId, sid, clock]`, with their
  dependencies and operation bytes as a `Uint8Array`. Exact duplicates are
  ignored; a different segment at the same place, an overlap or an actor fork
  fails with `CONFLICT` and the whole batch rolls back.
- `clocks`: the ready version vector of each document. Segments that arrive
  before their predecessors or dependencies stay pending, and are neither
  counted nor sent, until their history is complete.

`IndexedDbPatchStore` is exported for direct use, for example to serve
`relayStoreMessage` from a service worker.

## Limits and failures

- Up to 1024 actors per document, 4096 rows per frame and 1 MiB per segment,
  like every Pulsify store. A full disk fails with `LIMIT_EXCEEDED`.
- Pages that share a database reuse each other's
  [actor IDs](../../pulse/README.md#actor-ids) once they close, so reloads do
  not add actors. The connector's `actorPool` is `indexeddb:<name>`: one list
  of IDs per database.
- If IndexedDB cannot be opened (private browsing, blocked storage) or the
  browser closes the database, sessions fail with `CONNECTION_FAILED` and
  Pulsify reconnects later; the document keeps working from memory and the
  remote meanwhile.
- History is never compacted; a document's storage grows with its edits.

## Wiping local data

```ts
destroyPulse(note); // first: a live pulse would write its document back
await local.forget(noteId); // one document (sub-pulses have their own IDs)
await local.clear(); // every document, e.g. on logout
local.close(); // close the database; create a new connector to reopen it
```

## Options

| Option | Default | |
| --- | --- | --- |
| `name` | `"pulsify"` | Database name; use one per user to keep accounts apart. |
| `indexedDB` | `globalThis.indexedDB` | Another `IDBFactory`, e.g. `fake-indexeddb`. |
| `IDBKeyRange` | `globalThis.IDBKeyRange` | The key range class matching `indexedDB`. |
| `durability` | browser default | Transaction durability hint (`"strict"`, `"relaxed"`). |

## Tests

```sh
bun test packages/connectors/IndexedDB/tests
```

The tests run on `fake-indexeddb`: store conformance, reloads with rich text,
arrays and sub-pulses, offline edits uploaded to a remote, multiple sessions and
tabs, aborts and reconnections.
