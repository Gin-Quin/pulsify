# Native database load benchmark

The executable is Rust, using in-process `postgres` (PostgreSQL wire protocol)
and `rusqlite` clients. Bun generates real Pulsify fixtures, orchestrates private
servers and validates document replay. It is outside measured request execution.
See [results](RESULTS.md), the [mixed-workload optimization campaign](../baselines/database-mix-optimization-20261104/README.md) and [archived FoundationDB results](archive/FOUNDATIONDB-RESULTS.md).

AlloyDB Omni, OrioleDB and pgrust were uninstalled after the recorded campaign
at the user's request. Their Docker images and native pgrust download are no
longer on this Mac. Results and optional benchmark configurations remain;
selecting those Docker engines again downloads their images. See the
[removal audit](../baselines/database-engines-20261104/DATABASE-REMOVAL.md).

## Engines and deployments

| `--databases` name | Docker image | Native mode used in campaign | Table access method |
|---|---|---|---|
| postgres | postgres:16-alpine | PostgreSQL 16 | heap |
| sqlite | Rust runner, bundled SQLite | bundled SQLite | WAL file |
| alloydb | google/alloydbomni:17.10.0 | unavailable | heap, AlloyDB Omni server |
| orioledb | orioledb/orioledb:latest-pg17 | unavailable | orioledb |
| pgrust-row | malisper/pgrust:v0.4-beta | official macOS ARM64 release | heap |
| pgrust-columnar | same version, separate fresh server | same release, fresh cluster | pgrcolumnar |

`alloydb` means **AlloyDB Omni locally**, not managed Google Cloud AlloyDB. The
[official container guide](https://docs.cloud.google.com/alloydb/omni/containers/current/docs/quickstart)
currently names 18.4.0, which the registry did not serve during this campaign;
17.10.0 was available and is the tested version. ARM support is preview. Aurora
is excluded: the requested open-source condition is not met; no AWS resources
are created. OrioleDB is Apache-2.0/PostgreSQL licensed, pgrust is AGPL-3.0;
AlloyDB Omni has Google's own terms. Only Aurora was conditional on open source.
Image IDs, digests, engine versions, settings and architecture are captured.
OrioleDB is measured in Docker here: its [official macOS development guide](https://www.orioledb.com/docs/contributing/local-builds) starts by disabling System Integrity Protection. This campaign leaves that system protection unchanged.

## Run

Install Bun, Rust/Cargo and Docker Compose. Native PostgreSQL needs
`brew install postgresql@16` (or `PG_BIN`). Native pgrust needs the
[official 0.4-beta download](https://pgrust.com/downloads/v0.4-beta/), verified
with its adjacent SHA-256 file; set `PGRUST_BIN` to its extracted `bin` directory.
No system installer or launch daemon is used.

```sh
# Defaults: PostgreSQL + SQLite, macOS native and Docker.
bun run bench:database --quick

# Verify the new engines before investing in a full load run.
bun run bench:database --environment docker --quick --contract-only \
  --databases alloydb,orioledb,pgrust-row,pgrust-columnar

# Every operation + the exact mix; medium history; independent burst/saturation.
bun run bench:database --environment both --profile medium \
  --databases postgres,sqlite,alloydb,orioledb,pgrust-row,pgrust-columnar \
  --concurrency 1,16,64 --requests 1000 \
  --results-dir benchmarks/results/engines-medium

# Large history and 128 simultaneous clients, bounded Docker containers.
bun run bench:database --environment docker --profile large \
  --databases postgres,sqlite,alloydb,orioledb,pgrust-row,pgrust-columnar \
  --concurrency 128 --requests 1000 \
  --results-dir benchmarks/results/engines-large

# Focused hot-document mixed burst.
bun run bench:database --environment docker --databases pgrust-columnar \
  --concurrency 64 --requests 1000 --scenarios mixed --topologies hot --modes burst \
  --results-dir benchmarks/results/pgrust-hot
```

Use `--help` for filters. Requests must be a multiple of 20. Each measured
backend runs alone, with a fresh private cluster/file and no public Docker
ports. Servers and only this invocation's volumes are removed on completion,
failure, SIGINT or SIGTERM. Unsupported native deployments are recorded in
`context.json`; a Linux container on macOS is never labelled bare metal.
Use a fresh results directory per campaign. `PULSIFY_NATIVE_IMAGE` selects a
prebuilt runner; otherwise it builds `native.Dockerfile` with a build-only RAM
mount for compiler outputs. Database data is disk-backed. Cargo.lock is pinned.

`context.json` checkpoints provenance and failures after every backend. Raw
JSON checkpoints completed cells and stores every request. The orchestrator
continues independent backends after a failure, verifies complete matrices and
Pulsify replay, writes `REPORT.md`, then exits nonzero if any backend or request
failed. A partial report is diagnostic evidence, never a completed score.

## Memory limits and observed columnar failure

Docker server and runner containers now have **4 GiB RAM and no swap** each.
Effective limits and final server state (including OOMKilled) are saved before
cleanup. The retained medium run predates this guard and used the VM defaults;
its original Compose configuration is archived with the results.

The full native pgrust columnar series at 128 clients produced severe query-memory
amplification and 584 timeouts in spread compaction. The Mac subsequently
rebooted; the reboot's cause is not established. Its matrix is explicitly partial.
Use bounded Docker for reproducing this heavy configuration on a workstation.
Native PostgreSQL, SQLite and pgrust row were also measured at 128 clients.

After a fatal or interrupted series, fresh isolated probes test the remaining
operation groups. Those scores stay separate: fresh table state can behave very
differently from a table containing prior full writes, deletions and tombstones.
For example, a single fresh mixed cell can be run with `--scenarios mixed
--topologies hot --modes saturation`; use a new results directory. Failed cells
without a checkpoint are never counted as zero errors or successful requests.

`bun benchmarks/database/native-summary.ts PATH` summarizes medium, large,
large-docker and supplemental phase directories, including incomplete matrices
and separate fresh-probe outcomes.

## Work and concurrency

The fixture is produced by the real typed Pulsify API, not invented operation
bytes. It uses the existing small/medium/large document profiles (20/100/1,000
historical edits). Each worker has a genuine separate Pulsify actor and a
pre-generated causal scalar-patch stream. The database stores isolated scopes
of the same logical fixture: repeated payloads are valid document copies, not
changed envelope IDs surrounding incompatible initial data.

Each cell has fresh logical state. Cleanup uses DELETE and CHECKPOINT outside
timing; it does not reset physical files or remove all tombstones. Engine
maintenance and accumulated physical history can affect later cells. Its prebuilt request schedule is deterministically
shuffled. The mix is exactly:

| Task | Share |
| --- | ---: |
| Append one new patch | 45% |
| Read from a version vector | 25% |
| Write a complete initial pulse | 10% |
| Read complete history | 10% |
| Attempt lossless compaction | 10% |

Every client is a real OS worker thread with an independent SQL connection. A
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
service latency, not in the explicit retry counter. The latter counts common compaction-plan retries, so zero retries does
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

The Rust workload uses application transactions and parameterized SQL round
trips for its common policy. The production PostgreSQL store separately exposes
a single-call PL/pgSQL append path. These measurements characterize the benchmark
adapters and deployment choices; they are not engine throughput ceilings.
Docker SQLite uses a file in the runner's writable layer; the server engines use
named data volumes. Filesystem placement is part of these measured deployments.

All backends use binary Pulsify frames in indexed per-actor segments and
transactional contiguous clocks. SQL uses relational segment tables. PostgreSQL
uses a connection per worker and a document advisory transaction lock for
writes; reads use read-only repeatable-read transactions without that lock.
SQL statements are cached per connection, and append reads/updates the complete
frontier once per transaction. Full reads avoid an empty-vector join; SQLite
materializes a nonempty remote-vector CTE once per query.
SQLite uses WAL, `synchronous=FULL`, one connection per worker, immediate write
transactions, deferred read transactions, a 64 MiB read-only mmap limit and a
busy handler with 100–999 µs jittered sleeps and a 30-second wall-clock deadline.
Use `--sqlite-busy timeout` for SQLite's standard 30-second busy timeout and
`--sqlite-mmap-bytes 0` to disable mmap. Effective PRAGMAs and the busy policy
are recorded in each new report. Shorter waits can consume more CPU under
contention; throughput gains do not imply lower CPU cost. Its
single-writer scheduling is provided by SQLite itself, not by a JavaScript
promise queue.

OrioleDB explicitly creates both tables `USING orioledb`, after enabling its
extension and preloading the engine. pgrust-row explicitly uses `heap`, while
pgrust-columnar registers and uses `pgrcolumnar` for **both** segment and vector
tables. The CLI checks `pg_class`/`pg_am` and the actual server version before
running. pgrust 0.4-beta columnar has no unique indexes or `ON CONFLICT`: its
vector replacement is transactional DELETE + INSERT under the same document
advisory lock. Its non-unique `(doc,sid,start)` point index and `(doc,sid,end)` range index and application duplicate validation
preserve the contract, but this is a different physical schema and write plan.
The parallel preflight checks idempotency, conflicts, rollback, vector queries,
concurrent actor appends and compaction before any timing. No host-side mutex
stands in for database locking. See [upstream columnar support](https://github.com/malisper/pgrust#columnar-tables).

Compaction preserves every exact row and intermediate edit. It selects a closed
range excluding the latest segment of each actor, uses zlib level 6, and verifies
source identities, metadata and complete payloads transactionally before replacement.
Validation and deletion each use one indexed range statement per actor plan,
instead of one SQL call per segment. All plans are validated before any deletion;
the document/global write lock protects the range until commit. A changed range
is retried, and a deletion-count mismatch rolls the transaction back. It
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
SQLite uses its bundled Rust library, whose exact version is recorded. All
PostgreSQL-compatible deployments use the same connection/buffer/WAL settings,
including AlloyDB Omni (whose image otherwise auto-sizes a much larger buffer
pool). Effective durability and table engines are recorded in every raw report.
No server durability is disabled; these single-node settings do not simulate
replication or crash recovery.

After every cell, Rust reconstructs the journal/vector and compares all
accepted history row-for-row, including compaction races. Representative
histories are then imported through Pulsify in TypeScript, including reversed
row delivery; snapshots and vectors must converge. Proof hashes remain in the
report; large base64 replay frames are removed after verification. The native
executable runs the same live parallel contract before **every** backend's
campaign. SQLite and codec/mix unit tests run without external services:
`cargo test --release --locked --manifest-path crates/pulsify-db-bench/Cargo.toml`.
The optional Rust PostgreSQL unit test runs only with `PULSIFY_NATIVE_PG_URL`.

## Architecture

| File | Responsibility |
| --- | --- |
| `engines.ts` | Engine identities and supported deployment modes |
| `native-compose.yaml` | Isolated Docker server configuration |
| `native.ts` | Native/Docker setup, builds, provenance and cleanup |
| `native-fixtures.ts` | Real Pulsify actor streams and model replay |
| `native-report.ts` | Human-readable report from raw request records |
| `mix-comparison.ts` | Audit repeated mixed campaigns and enforce the 30% median-throughput target |
| `crates/pulsify-db-bench/src/model.rs` | Shared binary segments and integrity |
| `crates/pulsify-db-bench/src/storage/mod.rs` | Causal append/read/compaction policy |
| `crates/pulsify-db-bench/src/storage/{pg,sqlite}.rs` | Native transaction mechanics |
| `crates/pulsify-db-bench/src/main.rs` | Arrival scheduling, workers and metrics |
| `crates/pulsify-db-bench/src/contract.rs` | Live engine concurrency/atomicity preflight |
| `crates/pulsify-db-bench/src/tests.rs` | Concurrency, losslessness and exact mix contracts |

The legacy TypeScript suite is still available as `bun run bench:database:legacy`.
Its historical tests and baseline are intentionally preserved. Comparisons
between native macOS and Docker Linux include operating-system, filesystem,
server-version and VM differences; they do not isolate a universal Docker cost.
