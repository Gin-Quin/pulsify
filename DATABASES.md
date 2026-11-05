# Database Options for JsonCrdtOperation Storage

This project needs storage optimized for rows of `JsonCrdtOperation`.

The operation id is the tuple `(sid: number, time: number)`, matching
`ITimestampStruct`. A stored row may represent a span of multiple operations,
so a row has a `time_start` and `span`, with `time_end = time_start + span`.

Core requirements:

- Retrieve the current document clock as `Map<sid, clock>`.
- Given another `Map<sid, clock>`, return all local operation rows with a
  greater clock for each `sid`.
- Detect gaps in the operation sequence. For example, if `(2, 12)` exists but
  `(2, 10)` and `(2, 11)` are missing, store `(2, 12)` separately as dangling
  until the missing operations arrive.
- Support high-throughput append and range-read workloads.

## Recommended Default: PostgreSQL

PostgreSQL is the best default choice for a service backend unless there is a
known need for embedded storage or very high distributed write throughput.

It gives the right primitives:

- Composite primary keys.
- Efficient B-tree indexes.
- Transactions.
- Simple vector-clock queries using joins.
- `bytea` for compact binary operation payloads.
- `jsonb` if operation internals must be queried from SQL.
- Partitioning for larger deployments.

Prefer storing operation payloads as binary `bytea` unless SQL needs to inspect
the fields inside `JsonCrdtOperation`. The database mostly needs ordering,
slicing, and transport, not semantic knowledge of every operation variant.

Suggested schema shape:

```sql
create table crdt_op_rows (
  doc_id uuid not null,
  sid bigint not null,
  time_start bigint not null,
  span integer not null check (span > 0),
  time_end bigint generated always as (time_start + span) stored,
  ops bytea not null,
  primary key (doc_id, sid, time_start)
);

create index crdt_op_rows_clock_idx
  on crdt_op_rows (doc_id, sid, time_end);

create table crdt_doc_clocks (
  doc_id uuid not null,
  sid bigint not null,
  clock bigint not null,
  primary key (doc_id, sid)
);

create table crdt_dangling_op_rows (
  doc_id uuid not null,
  sid bigint not null,
  time_start bigint not null,
  span integer not null check (span > 0),
  time_end bigint generated always as (time_start + span) stored,
  ops bytea not null,
  missing_from bigint not null,
  missing_to bigint not null,
  primary key (doc_id, sid, time_start)
);
```

`crdt_doc_clocks` should represent the contiguous applied frontier, not merely
the highest observed timestamp. If `(2, 12)` arrives while `(2, 10)` and
`(2, 11)` are missing, store it in `crdt_dangling_op_rows` and do not advance
the clock for `sid = 2`.

Example query for retrieving rows newer than a remote vector clock:

```sql
with remote_clock(sid, clock) as (
  values
    (1, 42),
    (2, 9),
    (3, 100)
)
select o.*
from crdt_op_rows o
left join remote_clock r on r.sid = o.sid
where o.doc_id = $1
  and o.time_end > coalesce(r.clock, 0)
order by o.sid, o.time_start;
```

If a row spans `[10, 15)` and the remote clock is `12`, the row should match.
The application can either send the whole row and let the receiver ignore known
operations, or decode and slice the row from offset `clock - time_start`.

## JSON Joy Patch Payloads

`sid` means session ID. It is an actor/session identifier, not necessarily a
user ID. Together, `(sid, time)` identifies an operation or CRDT node.

JSON Joy CRDT patches are ID-based, not path-based. A creation operation such
as `{ "op": "new_vec" }` has no path; its object ID is derived from the patch
clock. Other operations make that object reachable by pointing to its timestamp.

The verbose JSON codec shape is:

```ts
type JsonCodecPatch = {
  id: [sessionId: number, time: number];
  ops: JsonCodecOperation[];
  meta?: unknown;
};
```

Every operation has an `op` field, but a database row may contain many
operations, so a single `op` column is ambiguous. If useful, store distinct
operation types as `op_types text[]`; keep the authoritative payload encoded.

Prefer this payload split:

```sql
codec text not null,
payload bytea not null,
debug_patch jsonb
```

Use `payload bytea` as the source of truth. Use `debug_patch jsonb` only when
SQL inspection or easier debugging is worth the extra storage and parse cost.

## Patch Segments

For throughput, store larger contiguous segments instead of one row per
operation:

```text
(doc_id, sid, time_start, span) -> encoded patch segment
```

Flush a segment when it reaches an operation count, byte size, age threshold, or
document/session boundary. Keep segments contiguous and not too large; very
large segments reduce row count but waste bandwidth when peers only need a
suffix.

Practical defaults:

- Target encoded segment size: `16 KB` to `256 KB`.
- Hard max segment size: around `1 MB`.
- Store `op_count` and optional distinct `op_types`.

## Idempotent Inserts and Overlaps

Use the primary key for exact duplicate prevention:

```sql
insert into crdt_op_rows (doc_id, sid, time_start, span, ops)
values ($1, $2, $3, $4, $5)
on conflict (doc_id, sid, time_start) do nothing;
```

To prevent overlapping stored ranges, add an exclusion constraint:

```sql
create extension if not exists btree_gist;

alter table crdt_op_rows
add constraint crdt_op_rows_no_overlap
exclude using gist (
  doc_id with =,
  sid with =,
  int8range(time_start, time_end, '[)') with &&
);
```

If an incoming segment partially overlaps existing data, insert only the missing
ranges. For example, existing `[10, 20)` and incoming `[15, 25)` should produce
`[20, 25)`. PostgreSQL can compute the missing clock range, but the application
must decode and slice the encoded patch payload.

```sql
with incoming as (
  select
    $1::uuid as doc_id,
    $2::bigint as sid,
    int8range($3::bigint, $4::bigint, '[)') as r
),
covered as (
  select coalesce(range_agg(int8range(time_start, time_end, '[)')),
                  '{}'::int8multirange) as ranges
  from crdt_op_rows, incoming
  where crdt_op_rows.doc_id = incoming.doc_id
    and crdt_op_rows.sid = incoming.sid
    and int8range(time_start, time_end, '[)') && incoming.r
)
select
  lower(missing) as time_start,
  upper(missing) as time_end
from incoming, covered,
     unnest(int8multirange(incoming.r) - covered.ranges) as missing;
```

## Safe Compaction

Compaction must be conditional. Do not compact rows outside the database and
then overwrite blindly.

Recommended flow:

- Select a closed historical range, not the open write tail.
- Read the exact source rows and compute a fingerprint.
- Compact outside the transaction if needed.
- In a transaction, replace the rows only if the fingerprint still matches.
- If it does not match, discard the compacted result and retry later.

This prevents the race where one API compacts an old view while another API has
already inserted newer data.

## High-Throughput PostgreSQL Notes

For high throughput, treat PostgreSQL as an append log:

- Use binary payloads.
- Batch inserts.
- Keep secondary indexes minimal.
- Partition by `hash(doc_id)`, tenant, or another stable document bucket.
- Keep `crdt_doc_clocks` compact and transactionally updated.
- Consider periodic snapshots and compaction so operation history does not grow
  forever.
- Avoid `UNLOGGED` tables for durable CRDT history.

The largest throughput lever is compaction: keep recent operations for sync,
but periodically materialize snapshots and trim old operation ranges once
relevant replicas have advanced past them.

## Huge Append-Only Workloads: ScyllaDB or Cassandra

ScyllaDB or Cassandra-style wide-column storage can work well for very large
append-heavy workloads where reads are usually scoped to one document and one
`sid`.

Possible primary key:

```sql
primary key ((doc_id, sid), time_start)
```

This gives fast ordered reads per `(doc_id, sid)` partition. The tradeoff is
that contiguous clock maintenance and dangling-gap repair are less naturally
transactional, so more logic moves into the application.

## Embedded Storage

For local-first or embedded storage, use SQLite or RocksDB.

SQLite is the simpler option and works well when throughput is moderate. A
`WITHOUT ROWID` table with primary key `(doc_id, sid, time_start)` keeps storage
clustered by the access path.

RocksDB is better for high-throughput embedded append and range-scan workloads.
Use keys shaped like:

```text
doc_id | sid | time_start -> encoded row
```

RocksDB is an embedded storage engine, not a client-server database, so the
application owns more of the consistency and query logic.

## Databases Not Recommended as a Starting Point

MongoDB or a general document database is not the best starting point for this
problem. The hard requirements are ordered composite keys, vector-clock queries,
contiguous frontier tracking, and gap handling. These fit PostgreSQL,
SQLite, RocksDB, or ScyllaDB more directly.

## Practical Recommendation

Use PostgreSQL first for a product backend. Design the schema around
`(doc_id, sid, time_start)`, store operation rows as binary payloads, maintain a
separate contiguous clock table, and keep dangling operations in a separate
table until gaps are filled.

Use ScyllaDB for very large append-only workloads
where transactional gap repair can live mostly in application code. Use SQLite
or RocksDB for local embedded storage.

## Reproducible Database Benchmark

Run `bun run bench:database` to exercise real Pulsify documents against
PostgreSQL and file-backed SQLite on the host and inside Docker, plus AlloyDB
Omni, OrioleDB and pgrust 0.4-beta (row and columnar tables).
The Rust suite uses native clients and covers concurrent full writes/reads,
patch appends, lossless compaction, vector reads and a weighted mixed workload.
See the [benchmark guide](benchmarks/database/README.md) for architecture,
arrival modes, timing boundaries and storage policy.
