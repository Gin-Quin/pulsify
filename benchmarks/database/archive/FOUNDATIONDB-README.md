> Archived before FoundationDB removal on 2026-11-04. Installation commands and source paths here describe the former implementation. Use [the current guide](../README.md) for runnable commands. Raw measurements are preserved.

# Native database load benchmark

The default database benchmark is a Rust executable with in-process native
clients for PostgreSQL, FoundationDB and SQLite. FoundationDB uses
`foundationdb-rs` 0.11.0 and the official C API 730. There is no Python bridge,
per-key IPC, global client queue or single shared SQLite connection.

The [recorded results](FOUNDATIONDB-RESULTS.md) cover native macOS ARM64 and Docker Linux
ARM64. The earlier sequential Python-bridge suite is retained as
[legacy methodology](../LEGACY.md) and [legacy results](../LEGACY-RESULTS.md);
its timings cannot be compared directly with the concurrent Rust suite.

## Run

From the repository root, with Rust/Cargo, Bun and Docker Compose installed:

```sh
# Both deployments, small fixture, 4 clients and 20 requests per cell.
bun run bench:database --quick

# Full matrix: both deployments, medium history, 1/16/64 clients,
# five operations plus the exact requested mix, spread/hot, burst/saturation.
bun run bench:database

# Heavy campaign, writing into a fresh directory.
bun run bench:database --environment both --profile medium \
  --concurrency 1,16,64 --requests 1000 \
  --results-dir benchmarks/results/native-medium

# Larger histories and 128 concurrent clients.
bun run bench:database --environment both --profile large \
  --concurrency 128 --requests 1000 \
  --results-dir benchmarks/results/native-large

# Filter a workload without changing its implementation.
bun run bench:database --environment bare-metal --concurrency 64 \
  --scenarios mixed --topologies hot --modes burst --requests 1000
```

Arguments also include `--databases`, `--fdb-memory` (4GiB by default),
`--documents` (8 by default), `--modes`, `--scenarios`
and `--results-dir`; see `--help`. Requests must be a positive multiple of 20
so the mixed distribution is exact. Concurrency is bounded to 128 real actor
streams. Each successful cell is checkpointed; failed requests are retained
and cause the executable to exit unsuccessfully at the end. The orchestrator
continues other backends when a complete report contains request errors, then
exits unsuccessfully after the final report. Backend failures and incomplete
matrices are recorded in `context.json`; remaining independent backends still
run. Only a completed orchestration writes `context.json`
and the final `REPORT.md`. Use a new directory for each campaign.

Native macOS requires PostgreSQL 16 binaries, normally installed with
`brew install postgresql@16`; override their directory with `PG_BIN`. On ARM64,
missing FoundationDB 7.3.77 tools are downloaded from the official GitHub
release, checked against a pinned SHA-256, and extracted to a local tools
folder. The system installer and launch daemons are never invoked. Override
`FDB_TOOLS_DIR` with a folder containing `bin/fdbserver`, `bin/fdbcli` and
`lib/libfdb_c.dylib`. A Linux native run requires corresponding installed tools
and library paths; this campaign verified macOS native and Docker Linux.

Both native servers use fresh temporary directories and unused localhost
ports. Docker uses an isolated network and fresh volumes, without published
ports. SQLite is file-backed in both deployments. Servers, containers, volumes
and benchmark data are removed after success, failure, SIGINT or SIGTERM;
reports and build artifacts remain. Existing databases/services are untouched.
Only one measured backend stays active at a time; native PostgreSQL and
FoundationDB both stop before Docker measurement.

`PULSIFY_NATIVE_IMAGE` can select an already built Docker runner and skip its
build. Otherwise the orchestrator builds `native.Dockerfile`. Compilation
outputs and compiler temporary files use a build-only RAM mount; database data
never uses tmpfs. Native binaries compile with `FDB_CLIENT_LIB_PATH` and load
with the tools directory's library path. Cargo.lock pins the complete graph.

## Work and concurrency

The fixture is produced by the real typed Pulsify API, not invented operation
bytes. It uses the existing small/medium/large document profiles (20/100/1,000
historical edits). Each worker has a genuine separate Pulsify actor and a
pre-generated causal scalar-patch stream. The database stores isolated scopes
of the same logical fixture: repeated payloads are valid document copies, not
changed envelope IDs surrounding incompatible initial data.

Each cell has a fresh state. Its prebuilt request schedule is deterministically
shuffled. The mix is exactly:

| Task | Share |
| --- | ---: |
| Append one new patch | 45% |
| Read from a version vector | 25% |
| Write a complete initial pulse | 10% |
| Read complete history | 10% |
| Attempt lossless compaction | 10% |

Every client is a real OS worker thread with an independent PostgreSQL or
SQLite connection. FoundationDB shares its thread-safe native database handle,
with independent concurrent transactions and its native network thread. A
barrier admits workers together. Client startup, fixture generation, database
seeding and verification are outside timing. Write payloads are prepared
outside timing; the measured write is validation and durable persistence.
Reads include fetching, checksum verification, decoding/decompression and
checking complete coverage of the requested vector suffix. Materializing the
Pulsify application model is verified afterward, outside the Rust storage timer.

Two admission modes distinguish service time from waiting:

- **burst:** all N requests arrive at the same instant. At most C workers
  execute concurrently; the rest wait in the sender queue. End-to-end latency
  includes that wait, while service latency includes database locks/retries.
- **saturation:** each of C clients submits its next request after completing
  the previous one. It is a closed-loop finite batch, with no open-loop offered
  arrival rate and no artificial queue added to the latency.

The suite reports completed requests/s, service/queue/end-to-end p50/p95/p99,
raw per-request events, errors, native transaction retries, compaction CAS
retries and observed maximum active requests. These finite batches expose
contention and burst drainage; they are not long-running steady-state capacity
or SLO estimates. There is no coordinated-omission correction for closed-loop
samples. Increase requests and repeat campaigns on a quiet machine before
making capacity decisions. One extremely fast batch has few timing samples.

PostgreSQL lock waits and SQLite's internal busy-handler waits are included in
service latency, not in the explicit retry counter. The latter counts FDB
transaction retries and common compaction-plan retries, so zero retries does
not imply zero contention on a SQL backend.

**spread** targets a pool of eight existing scopes, configurable with
`--documents`; it does not imply one unique document per client. **hot** targets
one existing scope. Full writes always create unique scopes in both topologies.
Pure spread compaction gets a distinct seeded history of 33 rows for each
request, ensuring useful work. Pure hot compaction targets one closed range:
most attempts naturally become no-ops once another request has compacted it.
Mixed compactions share the existing scopes with reads and appends, exercising
real races; all no-ops and successful row reductions are counted separately.
Never compare raw compaction-attempt throughput as if every attempt rewrote
history. Use useful compactions/s and removed segments alongside it.

## Transactions and storage

All backends use binary Pulsify frames in indexed per-actor segments and
transactional contiguous clocks. SQL uses relational segment tables. PostgreSQL
uses a connection per worker and a document advisory transaction lock for
writes; reads use read-only repeatable-read transactions without that lock.
SQLite uses WAL, `synchronous=FULL`, one connection per worker, immediate write
transactions, deferred read transactions and a 30-second busy timeout. Its
single-writer scheduling is provided by SQLite itself, not by a JavaScript
promise queue.

FoundationDB has per-actor clock keys. Appends point-read only their own clock
and causal dependencies, then update the affected actor clock, avoiding a
shared vector-blob conflict between independent actors. Missing headers are
looked up by exclusive end; payloads are fetched in contiguous suffix ranges
per actor, with full pagination. Payload values are chunked at 64 KiB. The
native binding performs its normal conflict retry/backoff, with bounded retries
and a transaction timeout. These backend-specific mechanisms implement the
same storage policy; the public production adapters remain separate.

Compaction preserves every exact row and intermediate edit. It selects a closed
range excluding the latest segment of each actor, uses zlib level 6, and verifies
source identities and fingerprints transactionally before replacement. It
bounds a selected raw range to roughly 256 KiB and retains already compressed
segments. Concurrent appends survive; stale compaction plans are retried and
counted. Each request has a 32-plan compaction retry budget; reaching it is a
recorded request error rather than a silent success. Retry totals returned by
successful requests omit the failed request's exhausted attempts, so they are
a lower bound when errors occur. A vector inside a compressed segment requires decoding that segment,
then filtering known rows. Compaction is not a state-only overwrite.

PostgreSQL keeps fsync, synchronous commits and full-page writes enabled.
Both deployments use 180 allowed connections, 128 MiB shared buffers, a 128 MiB
WAL target, 32 MiB minimum WAL and a 60-second checkpoint interval. Cleanup
checkpoints run outside cell timing to bound retained WAL on the test machine.
FoundationDB uses disk-backed `single ssd`, a configurable 4 GiB resident-memory limit,
256 MiB storage-memory limit and 128 MiB page cache. SQLite uses its bundled Rust
library, whose exact version is recorded. No server durability is disabled;
these single-node settings do not simulate replication or crash recovery.

After every cell, Rust reconstructs the journal/vector and compares all
accepted history row-for-row, including compaction races. Representative
histories are then imported through Pulsify in TypeScript, including reversed
row delivery; snapshots and vectors must converge. Proof hashes remain in the
report; large base64 replay frames are removed after verification. The native
orchestrator also runs the Rust contract suite against all three live databases
before measurement. Local SQLite unit tests and codec/mix tests can be run with
`cargo test --release --manifest-path crates/pulsify-db-bench/Cargo.toml` when
the native FDB client library is available.

## Architecture

| File | Responsibility |
| --- | --- |
| `native.ts` | Native/Docker setup, builds, provenance and cleanup |
| `native-fixtures.ts` | Real Pulsify actor streams and model replay |
| `native-report.ts` | Human-readable report from raw request records |
| `crates/pulsify-db-bench/src/model.rs` | Shared binary segments and integrity |
| `crates/pulsify-db-bench/src/storage/mod.rs` | Causal append/read/compaction policy |
| `crates/pulsify-db-bench/src/storage/{pg,sqlite,fdb}.rs` | Native transaction mechanics |
| `crates/pulsify-db-bench/src/main.rs` | Arrival scheduling, workers and metrics |
| `crates/pulsify-db-bench/src/tests.rs` | Concurrency, losslessness and exact mix contracts |

The legacy TypeScript suite is still available as `bun run bench:database:legacy`.
Its historical tests and baseline are intentionally preserved. Comparisons
between native macOS and Docker Linux include operating-system, filesystem,
server-version and VM differences; they do not isolate a universal Docker cost.
