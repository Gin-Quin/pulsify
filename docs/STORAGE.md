# Operation storage

`pulsify-core/storage` stores `PulsePatchRow` segments. Storage is not
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

Rows are atomic and their operations are immutable. Duplicates are
idempotent. Reusing an ID with different operations, or forking one actor's
history, is a conflict and rolls back the complete append batch. The SQLite
store can [pack](#compaction) old rows together on disk, and unpacks them on
every read.

### Fields without history

A store keeps the last value only of a field that is not `versioned()`, so a
database grows with the size of its documents and not with the number of
edits. It does so without a schema, following
[the protocol](PROTOCOL.md#fields-without-history):

- **One row per actor and register.** A ready row whose payload is one
  last-value write (operation kind 7 or 8) is kept apart from history rows,
  under its document, its actor and its register: the encoded target and
  field, read from the payload head with `lastRegisterOf`. An actor's newer
  write to the register overwrites its older one in place. The store never
  compares it with another actor's write: a register written by five actors
  holds five values, and every replica that loads them picks the winner by
  `(lamport, sid)`, as it does for any rows it receives.
- **Holes.** The sequence numbers of a write that was overwritten hold
  nothing: no row, no gap row, no span. The actor's clock still says how far
  its history goes. A ready gap row (payload `03 01 00 00`) only moves the
  clock.
- **Spans are computed when rows are served.** `missing` takes, for each actor
  ahead of the peer, the rows it holds in clock order. Each one's span runs to
  the next one, and the last one's to the actor's clock. The row that holds
  the peer's clock is sent too, as before. When no row holds it, a gap row
  covers the sequence numbers up to the first one. A peer therefore still
  receives each actor's sequence without holes from its own clock on.
- **Spans from peers.** A row that starts below the clock is compared by its
  operations only, with what is held at that exact sequence number: a history
  row, a row inside a packed segment, or a value. If its span ends beyond the
  clock, the clock moves there, and nothing else is written. A row that waits
  and whose start falls inside another waiting row's span is dropped. A
  waiting last-value row becomes a value once it is ready, and a waiting gap
  row disappears.
- **What is kept.** Sequences, text, container assignments and versioned
  fields: every row.

A last-value write therefore costs two row writes, its value and its actor's
clock, like a history row: no row is read, deleted or rewritten. Six counters
uploaded together cost seven.

The SQLite stores keep the values in `pulsify_values(doc_id, sid, register,
clock, dependencies, operations)`, keyed by `(doc_id, sid, register)`, with a
secondary index `pulsify_values_clock(doc_id, sid, clock)` for clock-ordered
range scans and point lookups. The table and index are created on opening, and an
older database needs no migration: its rows are history rows. **Pulsify
versions before 13 cannot read a database that version 13 wrote to.**
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
returns only promoted rows whose computed end exceeds the remote actor clock,
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
payloads)`. Metadata is a compact JSON array; payloads use a binary
`bytea[]` parameter, never base64 or JSON. Of a payload, the function reads
only the head of a ready row, with `pulsify_register`, which reads the register
as `lastRegisterOf` does. A last-value row is upserted into `pulsify_values`,
keyed by `(doc_id,sid,register)`. The function takes a transaction-scoped advisory
lock for the document, checks only indexed neighboring segments, inserts the
batch and promotes pending metadata. No application transaction or read-before-
write round trip is required. The advisory lock also serializes causal updates;
hash collisions can serialize unrelated documents without changing correctness.
All writers must use the append function rather than insert directly.

The primary key is `(doc_id,sid,time_start)`, a partial document index
serves pending repair, and `pulsify_values_clock(doc_id,sid,clock)` indexes
last-value reads by clock; `initialize()` drops any legacy
`pulsify_rows_frontier` index. `missing` calls `pulsify_missing(doc_id, sids, clocks)`,
which joins the remote vector given as two numeric arrays, computes each behind
actor's lower bound once, reads its rows and values from those bounds, and
computes the spans; operation bytes remain `bytea`. `missingPage` calls
`pulsify_missing_page`, a `STABLE` function, so the document vector and a page's
rows come from one snapshot. It walks behind actors in `sid` order and seeks
each one's rows and values by keyset from where the previous page stopped,
64 keys and sizes at a time, and reads a payload only for a row the page
serves: a page costs what it returns, whatever the history's length or the
width of the rows it does not serve. The function disables bitmap and
sequential scans for its own statements, so its cached plans stay ordered
index scans that stop after a batch. It honors `maxRows`, `maxBytes` and `maxNodes`
as `SqlitePatchStore` does (the first row of a page is always served) and its
pages concatenate to what `missing` returns. Across pages, an actor already
served keeps the clock it was served to in `vv`; later actors are read at their
current clock, so appends between pages never leave a hole. A value overwritten
between pages becomes a gap row. Clock and ready-state updates commit
atomically. Ordinary logged tables retain PostgreSQL durability guarantees.

`PostgresQuery` is a small driver boundary. Drivers must bind the third append
parameter as a PostgreSQL binary array; Bun SQL does this directly. A `pg` or
other driver adapter should preserve `Uint8Array`/`Buffer` values when binding
`bytea[]`. Text metadata is explicitly cast through `text` before `jsonb` so
drivers do not encode a JSON string a second time.

## SQLite

Pass a compatible connection (for example `new Database(path)` from
`bun:sqlite`) to `SqlitePatchStore`. Tables use `WITHOUT ROWID`, a partial
pending index, and `pulsify_values_clock(doc_id, sid, clock)`; there is no
`time_end` index. `missing` and paged `missingPage` run in a single read
transaction, seeking each behind actor's rows and values from its remote clock
and merging them incrementally. Opening an older database drops its
`pulsify_rows_frontier` index and adds `pulsify_values_clock`; opening an
already-current database skips DDL. The append uses an immediate
transaction so competing writers cannot race between duplicate checks and
inserts. Each append checks the covering pending index without scanning or
parsing unrelated pending rows.
A ready actor's rows all start below its clock, so a row that starts at
that clock, has its dependencies covered and whose actor has no pending row
cannot be a duplicate or overlap: it is stored without reading any row, and
only its dependency on the actor's previous row is checked. Other rows read
their actor neighbors. SQLite 3.32+ is
recommended for its larger default bound-parameter limit when vectors contain
hundreds of actors. Configure WAL/durability on the connection according to the
application's requirements.

### Compaction

A document keeps one stored row per update that keeps its history (text and
array edits, versioned fields), and a peer that connects with an empty vector
reads them all. `SqlitePatchStore.compact()` folds runs of
consecutive ready rows of one actor into **packed segments**, so that a long
history is read as a few rows. Values are never packed:

```ts
let after: SqliteCompactCursor | undefined;
do after = (await store.compact({ after })).next;
while (after);
```

Compaction is opt-in and internal to storage. A store that never calls it keeps
one row per update. Nothing changes for peers: `missing` returns the rows inside
a packed segment exactly as they were appended, including the complete row that
straddles the remote clock; `vector` and the clocks table are untouched, since
packing never moves the causal frontier; and `append` answers a resend of a
packed row as before: idempotent when identical, a conflict when it differs,
overlaps or forks. Packed segments never reach the wire, where a core row still
spans one sequence number.

A packed segment is one row of `pulsify_op_rows` with `packed = 1`. It keeps the
key and the dependencies of its first row, spans all of them, and its
`operations` hold each row in order: `span`, the number of dependencies, each
`[sid, clock]`, the length of the operations and their bytes, every number as a
LEB128 varuint. The spans of the rows inside tile the segment, so their clocks
are not stored: a row's span runs to the next row, over the holes between
them. A segment that is extended over a hole first takes a gap row that fills
it; gap rows inside a segment are never served. Encoded rows are concatenated:
a segment grows by appending.

- **Only ready rows are packed.** Dangling rows stay as they are until promoted.
- **Size.** A segment holds at most 256 KiB (`MAX_PACKED_BYTES`). A row larger
  than that stays unpacked.
- **Threshold.** A run of fewer than `minRows` unpacked rows of one actor
  (default 64) is left alone, so small documents and short tails are not
  rewritten.
- **Extension.** A run that follows a packed segment is appended to it while it
  has room. Repeated compactions therefore fill segments instead of leaving
  one small segment each.
- **Budget.** One call reads at most `maxRows` stored rows (default 4096) of
  all documents in one immediate transaction, and returns in `next` where to
  resume, or `undefined` once every row has been seen.

Appending after a compaction costs the same: a row at its actor's frontier is
still inserted without reading any row. Only a resend of a row that lies inside
a segment decodes that segment.

Packing a row deletes it, which is one more write per update over its lifetime;
in exchange a cold read of 10,000 updates of one actor reads 1 row instead of
10,000, and the database is smaller.

Opening a database created before packed segments adds the `packed` column in
place (`SQLITE_PACKED_MIGRATION`). The Rust `pulsify-sqlite` crate reads packed
segments and migrates the same way, but does not compact. **Pulsify versions
before 11 cannot read a compacted database**: they would serve a packed
segment as one row. Compact only once every process that opens the file runs
version 11 or later, and never roll a compacted Pulsify Cloud root back to an
earlier version.

## Other databases

Implement `PatchStore` from `pulsify-core/storage` and pass the store to
`relayStoreMessage`. The contract is the one described above: immutable operations, at least each actor's newest write to a register without history,
idempotent duplicates, conflicts that roll back the whole batch, and rows that
stay dangling until their predecessors and dependencies are stored. Any database
with ordered keys and atomic batches can provide it. `IndexedDbPatchStore` in
`pulsify-indexeddb` is an example outside SQL.

In Rust, the `PatchStore` trait of `pulsify-protocol` is the same contract,
and `relay_frame` and `Hub` serve frames from any implementation. Two are
provided: `pulsify-sqlite`, file-compatible with `SqlitePatchStore`, and
[`pulsify-rocksdb`](../crates/pulsify-rocksdb/README.md), which keeps rows
under `doc_id NUL sid clock` keys in RocksDB, with clocks and pending rows in
their own column families. Their tests apply the same random histories to both
and require identical answers. The RocksDB store does not pack rows into
segments: consecutive keys already share compressed blocks.

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

## Permanent document lifecycle (version 14)

SQLite and IndexedDB implement `DocumentStore` in addition to `PatchStore`;
the native SQLite/RocksDB stores implement `pulsify_protocol::DocumentStore`.
`deleteDocuments(prefix)` / `delete_documents(prefix, false)` retire an entire
ID-prefix subtree permanently, including documents never seen by the store.
A slash is a boundary: deleting `a/b` never deletes `a/bc`. Repeated deletion is
safe. SQLite uses `pulsify_tombstones(prefix)`; RocksDB adds a `tombstones`
column family; IndexedDB schema version 4 adds a tombstone object store.

All ordinary append/vector/missing/sync-state operations reject covered IDs
with `NOT_FOUND`, before consulting cached state. No generation or TTL clears
a marker. Native RocksDB deletion syncs its atomic write batch even if ordinary
writes use relaxed durability. SQLite checks deletion in its append transaction.
Caches are invalidated after a committed deletion. Older databases migrate on
opening; older Pulsify binaries must not open a version-14 database.

Local replicas can retain data with `preserveRows:true` / `preserve_rows=true`.
The normal protocol cannot read that data. Explicit `recoverRows(docId)` /
`recover_rows(doc_id)` returns retained operations for recovery without making
the ID live again. `markDeleted` / native SQLite `mark_deleted` retain current
in-memory operations before recording an authoritative deletion. Clearing local
cached rows does not remove deletion markers. Data preservation is best effort
when storage fails; failures are reported and the loaded snapshot remains readable.
Failed or malformed recovery still records the deletion and retires other local
sessions once the marker is durable.

`documents(prefix,after,limit)` lists live IDs with committed clocks, in ID order,
for bounded subtree fetching. It excludes tombstoned retained data and documents
whose only rows are waiting for dependencies. The standard PostgreSQL patch
adapter remains an operation store; it does not provide these lifecycle methods.
Listings seek past `after` in separate exact-ID and descendant ranges. Tombstone
filtering uses indexed ancestor lookups rather than scanning all stored markers.
