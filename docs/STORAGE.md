# Operation storage

`pulsify-core/storage` stores immutable `PulsePatchRow` segments. Storage is not
tied to one database: a store is any implementation of the `PatchStore`
interface (`append`, `appendEncoded`, `vector` and `missing`). PostgreSQL and
SQLite stores are included; PostgreSQL is the first optimization target.
[Other databases](#other-databases) implement the same four methods.

The envelope is `{docId, sid, clock, span, dependencies, operations}`. `clock`
and `clock + span` delimit a half-open actor range. `dependencies` contains
exclusive causal frontiers. The payload is opaque codec bytes: storage never
decodes operations, instantiates the document schema or reads a materialized
document. `appendEncoded` accepts the existing encoded protocol update/sync
frame directly; it decodes the envelope once and forwards its binary payload.
The relay/application still owns authentication, authorization and semantic
validation of operation contents. `relayStoreMessage` from `pulsify-core/protocol`
serves protocol frames directly from a store. `pulsify-cloud-server/cloudflare` adapts
Durable Object SQLite to the `SqliteConnection` interface.

Rows are atomic and immutable. Exact duplicates are idempotent. Reusing an ID
with different bytes, overlapping immutable segments, or forking one actor's
history is a conflict and rolls back the complete append batch. Peers must keep
segment boundaries stable; storage does not resegment or compact their payloads.
New core transactions use one sequence number each, starting at 1; their
Lamport order is carried separately inside the payload. Storage and the v2
protocol journal both require contiguous actor sequences starting at 1. The
generic storage envelope also supports segments spanning several consecutive
sequence numbers; it never treats a Lamport jump as a complete actor history.
Documents support up to 1024 distinct actors, including actors with dangling
history, so every stored frontier remains a valid protocol version vector.
An append that exceeds this capacity rolls back the complete batch.

A row stays dangling until its start equals the actor's contiguous frontier
(initially 1) and every dependency is covered. This also blocks undeclared gaps:
a first row starting at 10 with no dependencies cannot advance the clock.
Appending a missing
predecessor promotes dependent rows and advances the causal frontier in the
same transaction. `vector` returns only complete causal history. `missing`
returns only promoted rows whose exclusive end exceeds the remote actor clock,
including complete rows that straddle that clock. Receiving replicas ignore the
known prefix. No document contents are needed for these operations.

## PostgreSQL

Construct `PostgresPatchStore` with a parameterized query function and call
`await store.initialize()` once when installing the schema. For Bun:

```ts
import { SQL } from "bun";
import { PostgresPatchStore } from "pulsify-core/storage";

const sql = new SQL(process.env.DATABASE_URL!);
const store = new PostgresPatchStore((query, parameters) =>
  sql.unsafe(query, parameters as never[]));
await store.initialize();
await store.appendEncoded(requestBytes);
const suffix = await store.missing(documentId, remoteVector);
```

An append uses **one database round trip**: `pulsify_append(doc_id, metadata,
payloads)`. Metadata is a compact JSON array; payloads use a binary `bytea[]`
parameter, never base64 or JSON. The function takes a transaction-scoped advisory
lock for the document, checks only indexed neighboring segments, inserts the
batch and promotes pending metadata. No application transaction or read-before-
write round trip is required. The advisory lock also serializes causal updates;
hash collisions can serialize unrelated documents without changing correctness.
All writers must use the append function rather than insert directly.

The primary key is `(doc_id,sid,time_start)`. An index on
`(doc_id,sid,time_end)` serves delta reads, and a partial document index serves
pending repair. `missing` joins the remote vector using two numeric arrays and
`unnest`; operation bytes remain `bytea`. Clock and ready-state updates commit
atomically. Ordinary logged tables retain PostgreSQL durability guarantees.

`PostgresQuery` is a small driver boundary. Drivers must bind the third append
parameter as a PostgreSQL binary array; Bun SQL does this directly. A `pg` or
other driver adapter should preserve `Uint8Array`/`Buffer` values when binding
`bytea[]`. Text metadata is explicitly cast through `text` before `jsonb` so
drivers do not encode a JSON string a second time.

## SQLite

Pass a compatible connection (for example `new Database(path)` from
`bun:sqlite`) to `SqlitePatchStore`. Tables use `WITHOUT ROWID`, the same actor
range indexes and a partial pending index. The append uses an immediate
transaction so competing writers cannot race between duplicate checks and
inserts. Only pending metadata and actor neighbors are read. SQLite 3.32+ is
recommended for its larger default bound-parameter limit when vectors contain
hundreds of actors. Configure WAL/durability on the connection according to the
application's requirements.

## Other databases

Implement `PatchStore` from `pulsify-core/storage` and pass the store to
`relayStoreMessage`. The contract is the one described above: immutable rows,
idempotent duplicates, conflicts that roll back the whole batch, and rows that
stay dangling until their predecessors and dependencies are stored. Any database
with ordered keys and atomic batches can provide it. `IndexedDbPatchStore` in
`pulsify-indexeddb` is an example outside SQL.

## Document identifiers

Document IDs must be well-formed Unicode, contain no NUL and have at most 1024
UTF-16 code units. Both stores validate IDs on writes and reads.

## Integration checks and measurements

Run `bun run test:storage` for the storage conformance suite. The core storage suite
runs against actual SQLite, without Docker, a database server or credentials.
The browser connector keeps its IndexedDB tests; the native benchmark contract
tests also cover RocksDB and LMDB via `bun run test:database:rust`. The PostgreSQL
integration suite and its conditional skip have been removed. The two batch regression scenarios also run against SQLite.

The common suite checks duplicate handling, conflicts, transactional rollback,
overlapping ranges, actor forks, gaps, cross-actor dependencies, partial-frontier
queries, opaque frame ingestion, concurrent appends and large binary payloads.

`PULSIFY_POSTGRES_URL=… bun scripts/bench-storage-postgres.ts` measures append
batches and ten-row delta reads on PostgreSQL only. See the
[measured optimization results](STORAGE-BENCHMARKS.md) and the separate
[native Rust load benchmark](../benchmarks/database/README.md).

Transaction locking follows [PostgreSQL advisory locks](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS).

FoundationDB support and installation tooling were removed at the user's request.
Its [historical measurements](../benchmarks/database/archive/FOUNDATIONDB-RESULTS.md)
and raw results remain archived.

### Grouped transport ingress

`appendEncoded` also accepts negotiated envelope-2 scalar runs. The common decoder
bounds the expanded history before allocating rows, owns the frame and exposes
byte-exact original payloads lazily. Store adapters then expand those payload
headers into the same immutable rows as v1; no application schema or document read
is needed, and no database schema migration is required. PostgreSQL still performs
one append function call. Version-vector queries, exact duplicates and actor forks
have the same behavior for either incoming representation. The real-database
conformance suite covers grouped ingress and partial queries on both stores.


### State transport and exact persistence

Envelope-3 state deltas are a download/peer optimization, not durable operations.
Every `appendEncoded` adapter rejects them with `HISTORY_UNAVAILABLE` before any
database append. Native connections upload full original rows in envelopes 1/2;
no schema or row-format change is required in PostgreSQL or SQLite.
The shared conformance suite verifies rejection and exact 101-row persistence on
both actual databases.

A client's state vector may cover operations whose bytes it does not retain.
Use that vector for incremental state synchronization, and its physical history
vector for exact backfill. `recoverPulseHistory` checks that the requested bytes
were obtained; a final state delta never serves as proof of a complete upload.
See [state and history semantics](PROTOCOL.md#optional-state-deltas-envelope-3).
