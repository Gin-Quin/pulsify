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

## Distributed High Throughput: FoundationDB

FoundationDB is a strong fit when the system needs very high distributed write
throughput with ordered range scans and transactions.

Possible key layout:

```text
ops/{doc_id}/{sid}/{time_start}        -> encoded op row
clocks/{doc_id}/{sid}                  -> contiguous clock
dangling/{doc_id}/{sid}/{time_start}   -> encoded dangling row
```

This maps naturally to the access pattern, but it requires more application-side
data modeling and operational knowledge than PostgreSQL.

Use FoundationDB when the workload is beyond a single PostgreSQL deployment or
when distributed transactional ordered keys are a primary requirement.

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
FoundationDB, SQLite, RocksDB, or ScyllaDB more directly.

## Practical Recommendation

Use PostgreSQL first for a product backend. Design the schema around
`(doc_id, sid, time_start)`, store operation rows as binary payloads, maintain a
separate contiguous clock table, and keep dangling operations in a separate
table until gaps are filled.

Move to FoundationDB when the system needs distributed transactional ordered
keys at very high throughput. Use ScyllaDB for very large append-only workloads
where transactional gap repair can live mostly in application code. Use SQLite
or RocksDB for local embedded storage.
