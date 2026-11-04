# PostgreSQL storage measurements

Measured locally on 2026-11-04 with Bun 1.4.4, PostgreSQL 16.15 in an isolated
Docker container on macOS/ARM64. Logged tables, ordinary durable commits and
128-byte opaque operation payloads were used. The script performs two warmups
and six measured runs per size; the statistic is the upper middle observed
sample of the six (called `UpperMedianMs` in the JSON output). These are local
database measurements, not a comparison with other CRDT engines.
They were captured during optimization, before the final contiguous-frontier,
actor-capacity and namespace validation hardening, and are historical tuning
measurements rather than a claim about the final revision's exact latency.

| Rows per append | Initial append (ms) | Optimized append (ms) | Optimized delta of at most ten rows (ms) |
| ---: | ---: | ---: | ---: |
| 1 | 1.904 | 2.851 | 0.494 |
| 100 | 11.185 | 7.726 | 0.485 |
| 1000 | 319.603 | 22.173 | 0.602 |

Batch insertion and causal promotion improved substantially (14.4× at 1000
rows). Single-row commits did not improve; their durable Docker round-trip
latency is included. Treat submillisecond differences and the small-batch
numbers cautiously because other local activity and Docker I/O add noise.

The initial function executed validation, insertion and clock updates per row.
The optimized function validates incoming IDs and neighboring indexed ranges with
set operations, inserts the batch in one statement, proves whether the incoming
actor chains are causally closed, and promotes a closed batch with one update
and grouped clock upserts. Cross-actor gaps use the general metadata-only
dependency repair path. A dedicated one-row path avoids the batch proof cost.
JIT is disabled locally for this function because compiling small metadata
queries was more expensive than executing them.

The same ordering and grouped-clock ideas were applied to SQLite and
FoundationDB without running optimization benchmarks on those backends. The
three real-database conformance suites passed before that final transfer;
PostgreSQL additionally passed deterministic out-of-order causal-graph and
within-batch equivocation checks for its set-based path.

Reproduce with a disposable database:

```sh
PULSIFY_POSTGRES_URL=postgres://… bun scripts/bench-storage-postgres.ts
```

The script only removes documents that it creates. It does not change
PostgreSQL server durability settings or create unlogged tables.
