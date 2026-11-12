# PostgreSQL storage measurements

For the newer native Rust load suite with real Pulsify documents, vector reads
and compaction, see the
[database benchmark results](../benchmarks/database/RESULTS.md). The historical
measurements below exercise the public PostgreSQL adapter with opaque bytes;
the new suite uses separate reference adapters and is not directly comparable.

Measured locally on 2026-11-04 with Bun 1.4.4, PostgreSQL 16.15 in an isolated
Docker container on an Apple Silicon host. Logged tables, ordinary durable
commits and 128-byte opaque operation payloads were used. The script performs two warmups
and six measured runs per size; the statistic is the upper middle observed
sample of the six (called `UpperMedianMs` in the JSON output). These are local
database measurements, not a comparison with other CRDT engines.
The historical optimization numbers were captured before the final
contiguous-frontier, actor-capacity and namespace validation hardening. They
are tuning measurements rather than a claim about the final revision's exact
latency; the final revision was measured separately below.

## Final correctness-hardened revision

The production source at commit `713b7db54c01dfb176deb8efb65cb0e3251b40ad`
was measured separately on 2026-11-04 after the contiguous-frontier,
actor-capacity and namespace fixes. The source tree matched that revision.
Only the benchmark script changed, to retain its raw sample arrays; its timed
workload was unchanged. This is one absolute measurement campaign, with no
concurrent benchmark campaign and no final-run comparison ratio against the
historical runs below.

| Rows per append | Append upper-middle sample (ms) | Delta upper-middle sample (ms) | Rows returned by delta |
| ---: | ---: | ---: | ---: |
| 1 | 2.024084 | 0.224875 | 1 |
| 100 | 6.872250 | 0.323875 | 10 |
| 1000 | 24.245916 | 0.639417 | 10 |

The [complete JSON record](storage-postgres-final-20261104.json) includes all
warmup and measured timings, image ID, server settings and measured revision.
For example, the six 1000-row append samples were 21.982083, 67.634584,
24.245916, 22.041625, 20.709500 and 24.273916 ms. The 67.634584 ms observation
is retained; this campaign was not repeated to remove it.

The exact workload uses a fresh document for each execution, actor 70001,
contiguous clocks starting at 1, span 1 and 128-byte opaque payloads. Each size
runs eight times: two warmups followed by six measured executions. The reported
statistic is the fourth observation after sorting those six samples, rather
than their arithmetic median. The append timer includes envelope validation,
metadata preparation, one database call and its durable transaction; schema
installation and cleanup are outside the timers. The delta query uses remote
clock `max(1, batchSize - 9)`, producing one or ten rows as shown above.

PostgreSQL 16.15 ran in a new disposable `postgres:16-alpine` container over
localhost TCP, with Bun 1.4.4. The captured server settings were
`fsync=on`, `synchronous_commit=on` and `full_page_writes=on`; server JIT was on
and the append function retained its local `jit=off` declaration. No durability
setting was changed. The container was removed after measurement. No SQLite or
FoundationDB optimization measurements were run.

## Historical optimization measurements

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
