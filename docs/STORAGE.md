# Operation storage

`@pulsify/core/storage` stores immutable `PulsePatchRow` segments. PostgreSQL is
the first optimization target. SQLite and FoundationDB expose the same
`append`, `appendEncoded`, `vector` and `missing` methods.

The envelope is `{docId, sid, clock, span, dependencies, operations}`. `clock`
and `clock + span` delimit a half-open actor range. `dependencies` contains
exclusive causal frontiers. The payload is opaque codec bytes: storage never
decodes operations, instantiates the document schema or reads a materialized
document. `appendEncoded` accepts the existing encoded protocol update/sync
frame directly; it decodes the envelope once and forwards its binary payload.
The relay/application still owns authentication, authorization and semantic
validation of operation contents.

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
import { PostgresPatchStore } from "@pulsify/core/storage";

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

## FoundationDB

Pass an `OrderedKeyValueDatabase` adapter to `FoundationDBPatchStore`. Its
`transact` method must create a real read/write transaction, expose ordered
range reads with normal conflict tracking, commit atomically, and retry the
**whole callback** on retryable FoundationDB errors. The store has no native
binding dependency and can share an application's existing binding.

Document IDs must be well-formed Unicode, contain no NUL and have at most 1024
UTF-16 code units. All three stores validate IDs on both writes and reads, so
UTF-8 conversion cannot alias distinct documents.

Keys are prefixed by namespace and UTF-8 document ID, each encoded as a separate
hex component, followed by
fixed-width hexadecimal actor/clock numbers. Separate prefixes hold immutable
row metadata, dangling metadata, causal clocks, payload chunks and ready rows.
Ready rows are indexed by exclusive end, so a vector query seeks directly past
the remote frontier and does not load old payloads. Payloads are split into
64 KiB values to stay below FoundationDB's 100 KiB value limit. There is an
8 MiB estimated transaction budget per append, including encoded keys, payload
chunks, metadata and conflict ranges, to leave margin below the 10 MiB
transaction limit. Large gap-repair fan-outs and very large delta responses still need
application-level bounded scheduling/pagination before a production deployment.

## Integration checks and measurements

Run `bun scripts/test-storage.ts` with Docker available. It starts uniquely
named disposable PostgreSQL 16 and FoundationDB 7.3.77 containers, runs the same
suite against both and actual SQLite, then removes only those containers. The
FoundationDB Python test binding is downloaded from PyPI with a pinned SHA-256;
a test-only pipe exposes a real transaction to the TypeScript adapter. Patch
logic stays in TypeScript; there is no fake database in the integration suite.

For existing disposable services, set `PULSIFY_POSTGRES_URL` and
`PULSIFY_FDB_DOCKER` and run
`bun test packages/pulse/tests/storage.test.ts`. Without these variables, the
ordinary test command runs SQLite and explicitly skips the two external
integration suites. `scripts/fdb-test-bridge.py` must be copied to
`/tmp/pulsify-fdb-test-bridge.py` in the FDB container, with the Python binding
under `/tmp/fdb-python`.

The common suite checks exact duplicate handling, conflicting payloads,
transactional rollback, overlapping ranges, actor forks, gaps, cross-actor
dependencies, partial-frontier queries, opaque frame ingestion, concurrent
appends and payloads larger than a single FDB value.

`PULSIFY_POSTGRES_URL=… bun scripts/bench-storage-postgres.ts` measures append
batches and ten-row delta reads on PostgreSQL only. It uses two warmups and six
measured runs, 128-byte opaque payloads and batches of 1/100/1000 rows. SQLite
and FoundationDB receive functional checks, not optimization campaigns.
The JSON reports the upper middle measured sample; see
[the measured before/after results](STORAGE-BENCHMARKS.md).

Database constraints and transaction semantics follow the primary references:
[PostgreSQL advisory locks](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS),
[FoundationDB Python transactions](https://apple.github.io/foundationdb/api-python.html),
and [FoundationDB known limits](https://apple.github.io/foundationdb/known-limitations.html).
