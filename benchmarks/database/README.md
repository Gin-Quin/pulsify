# Native database load benchmark

The executable is Rust, using in-process `postgres` (PostgreSQL wire protocol)
and `rusqlite` clients. Bun generates real Pulsify fixtures and validates
document replay. It is outside measured request execution.

The reference results come from [a dedicated Linux server](#dedicated-server):
PostgreSQL, SQLite, RocksDB, LevelDB and LMDB on the same machine, with 1, 4
and 8 cores. The Docker orchestration below runs the other engines on a
workstation.
See the [results](RESULTS.md). Earlier campaigns, in Docker, on a VPS and on
Unikraft Cloud, are archived: [2026-11-11](../baselines/database-engines-20261111/README.md),
[2026-11-04](../baselines/database-engines-20261104/SUMMARY.md), the
[mixed-workload optimization](../baselines/database-mix-optimization-20261104/README.md)
and [FoundationDB](archive/FOUNDATIONDB-RESULTS.md).

AlloyDB Omni, OrioleDB and pgrust were uninstalled after the recorded campaign
at the user's request. Their Docker images are no longer on this Mac. Results and optional benchmark configurations remain;
selecting those Docker engines again downloads their images. See the
[removal audit](../baselines/database-engines-20261104/DATABASE-REMOVAL.md).

Valkey, Dragonfly, ScyllaDB and ClickHouse were removed after the 2026-11-11
campaign at the user's request: the images this benchmark pulled or built are no
longer on this Mac, and nothing was ever installed on the VPS. Results and
optional configurations remain; selecting those engines again downloads their
images.

## Engines

| `--databases` name | Docker image | Table access method |
|---|---|---|
| postgres | postgres:16-alpine | heap |
| sqlite | Rust runner, bundled SQLite | WAL file |
| alloydb | google/alloydbomni:17.10.0 | heap, AlloyDB Omni server |
| orioledb | orioledb/orioledb:latest-pg17 | orioledb |
| pgrust-row | malisper/pgrust:v0.4-beta | heap |
| pgrust-columnar | same version, separate fresh server | pgrcolumnar |
| rocksdb | Rust runner, bundled RocksDB | LSM tree, `TransactionDB` |
| rocksdb-mutex | Rust runner, bundled RocksDB | LSM tree, plain `DB`, write batches |
| lmdb | Rust runner, bundled LMDB | copy-on-write B+tree, memory-mapped |
| leveldb | Rust runner, bundled LevelDB 1.22 | LSM tree, write batches |
| valkey | valkey/valkey:9.0.3-alpine | in memory, append-only file |
| dragonfly | dragonflydb/dragonfly:v2.1.0 | in memory, append-only file, relaxed tier only |
| scylla | scylladb/scylla:latest | wide-column partition per document |
| clickhouse | clickhouse/clickhouse-server:25.7 | ReplacingMergeTree |

`alloydb` means **AlloyDB Omni locally**, not managed Google Cloud AlloyDB. The
[official container guide](https://docs.cloud.google.com/alloydb/omni/containers/current/docs/quickstart)
currently names 18.4.0, which the registry did not serve during this campaign;
17.10.0 was available and is the tested version. ARM support is preview. Aurora
is excluded: the requested open-source condition is not met; no AWS resources
are created. OrioleDB is Apache-2.0/PostgreSQL licensed, pgrust is AGPL-3.0;
AlloyDB Omni has Google's own terms. Only Aurora was conditional on open source.
Image IDs, digests, engine versions, settings and architecture are captured.

## Durability tiers

`--durability strict` (the default) requires every engine to flush a commit to
disk before acknowledging it. `--durability relaxed` lets each engine
acknowledge first and flush shortly after: a crash can lose the last moments
of accepted writes, never consistency. Pulsify clients resend every row the
server does not acknowledge on reconnection, so the relaxed tier matches what a
relay needs when clients keep their own journal. Run one tier per results
directory and compare engines within a tier only.

| Engine | strict | relaxed |
|---|---|---|
| PostgreSQL family | `synchronous_commit=on` | `synchronous_commit=off` (fsync stays on) |
| SQLite | WAL, `synchronous=FULL` | WAL, `synchronous=NORMAL` |
| RocksDB | WAL synced on every commit | WAL written, not synced |
| LevelDB | log synced on every write batch | log written, not synced |
| LMDB | default: synced on every commit | `MDB_NOSYNC` |
| Valkey | `appendfsync always` | `appendfsync everysec` |
| Dragonfly | not available | `--aof`, flushed in the background |
| ScyllaDB | `commitlog_sync: batch` | `commitlog_sync: periodic` |
| ClickHouse | `fsync_after_insert`, `fsync_part_directory` | no fsync on insert |

The runner reads each engine's effective settings back and refuses a campaign
whose settings do not match its tier.

Valkey and Dragonfly keep the whole dataset in RAM. Their numbers belong to a
separate category: they do not measure a store larger than memory.

## Run in Docker

Install Bun and Docker Compose.

```sh
# Defaults: PostgreSQL + SQLite.
bun run bench:database --quick

# Verify the new engines before investing in a full load run.
bun run bench:database --quick --contract-only \
  --databases alloydb,orioledb,pgrust-row,pgrust-columnar

# Every operation + the exact mix; medium history; independent burst/saturation.
bun run bench:database --profile medium \
  --databases postgres,sqlite,alloydb,orioledb,pgrust-row,pgrust-columnar \
  --concurrency 1,16,64 --requests 1000 \
  --results-dir benchmarks/results/engines-medium

# Large history and 128 simultaneous clients, bounded Docker containers.
bun run bench:database --profile large \
  --databases postgres,sqlite,alloydb,orioledb,pgrust-row,pgrust-columnar \
  --concurrency 128 --requests 1000 \
  --results-dir benchmarks/results/engines-large

# Focused hot-document mixed burst.
bun run bench:database --databases pgrust-columnar \
  --concurrency 64 --requests 1000 --scenarios mixed --topologies hot --modes burst \
  --results-dir benchmarks/results/pgrust-hot
```

Use `--help` for filters. Requests must be a multiple of 20. Each measured
backend runs alone, with a fresh private cluster/file and no public Docker
ports. Servers and only this invocation's volumes are removed on completion,
failure, SIGINT or SIGTERM.
Use a fresh results directory per campaign. `PULSIFY_NATIVE_IMAGE` selects a
prebuilt runner; otherwise it builds `native.Dockerfile` with a build-only RAM
mount for compiler outputs. Database data is disk-backed. Cargo.lock is pinned.

`context.json` checkpoints provenance and failures after every backend. Raw
JSON checkpoints completed cells and stores every request. The orchestrator
continues independent backends after a failure, verifies complete matrices and
Pulsify replay, writes `REPORT.md`, then exits nonzero if any backend or request
failed. A partial report is diagnostic evidence, never a completed score.

## Dedicated server

The reference campaign runs on a bare-metal Linux server, one engine at a time,
with nothing else on the machine. `dedicated/setup.sh` prepares an Ubuntu 24.04
server: Rust, Clang, Bun, PostgreSQL 18 from its own repository, an empty disk
formatted in ext4 and mounted on `/data` with `noatime`, SMT off and the
`performance` frequency governor. `dedicated/campaign.sh` then runs one
engine's matrix:

| Axis | Values |
|---|---|
| Cores | 1, 4, 8 |
| Document history | 100, 1,000, 10,000 edits (`edits-*` profiles) |
| Durability | strict, relaxed |
| Concurrent clients | 1, 16, 128 |
| Scenario | the mix, then each of its five operations alone |

Every cell is 2,000 requests on one hot document, in saturation mode: 324 cells
per engine.

```sh
rsync -a --exclude node_modules --exclude target --exclude .git \
  --exclude benchmarks/baselines --exclude benchmarks/results ./ server:pulsify/
ssh server 'sudo sh pulsify/benchmarks/database/dedicated/setup.sh /dev/nvme1n1'
ssh server 'cd pulsify && ~/.bun/bin/bun install --frozen-lockfile'
ssh server 'cd pulsify && sh benchmarks/database/dedicated/campaign.sh postgres'
# sqlite, rocksdb, leveldb, lmdb likewise; reports land in /data/results/<engine>
bun benchmarks/database/dedicated/report.ts <campaign folder> benchmarks/database/RESULTS.md
```

- **Cores.** The script takes the other cores offline in the kernel
  (`/sys/devices/system/cpu/cpuN/online`), so the limit covers the engine's
  background threads, the PostgreSQL server and the kernel's own work alike.
  The clients run on the same cores as the database: an engine inside the
  client process and a server reached through a Unix socket share them the
  same way.
- **One database per engine.** It is created when the campaign starts and
  nothing is deleted from it (`--keep-data`). Its directory is measured after
  the last cell (`size.json`), next to the payload bytes read back from it
  after each cell (`stored_payload_bytes`).
- **A server restart per series.** PostgreSQL is stopped and started around
  each (cores, history, durability) series, as an embedded engine closes and
  reopens its files.
- **One compiler.** The runner and every bundled engine are built with Clang.
- **Reports.** Per-request events are left out (`--no-events`); summaries,
  per-operation summaries and verification proofs remain.

Each engine has the configuration that suits this workload on this machine,
with one 16 GiB budget for the engines that have a cache of their own:

| Engine | Configuration |
|---|---|
| PostgreSQL 18 | `shared_buffers` 16 GiB, `max_wal_size` 32 GiB, 15-minute checkpoints, LZ4 for TOAST and WAL, `jit` off, `C` locale, Unix socket; other settings in `campaign.sh` |
| SQLite | WAL, memory-mapped reads (256 GiB limit), 64 MiB page cache per connection, checkpoint every 64 MiB of log |
| RocksDB | `TransactionDB`, 16 GiB block cache, one background thread per core, LZ4 then ZSTD, Bloom filters, blob files from 4 KiB |
| LevelDB | 16 GiB block cache, 64 MiB write buffer, Snappy, 10,000 open files |
| LMDB | defaults: it has no cache of its own and reads through the page cache; 1 TiB map |

## Other hosts: one image, Unikraft Cloud or any x86-64 Linux

`unikraft/` packages the runner, a fixture and the engines that fit a small
instance (SQLite, RocksDB, LMDB, PostgreSQL 16, Valkey, Dragonfly) into one
image. Its entrypoint runs each selected engine and tier alone on a fresh data
directory under `/data`, gzips the raw reports and serves them over HTTP on
port 8080. The orchestration differs from `native.ts`; the runner, fixture
format and storage adapters are the same.

```sh
benchmarks/database/unikraft/stage.sh large   # x86-64 runner + fixture
# Docker through OrbStack: DOCKER_HOST=unix://$HOME/.orbstack/run/docker.sock
unikraft build benchmarks/database/unikraft --output <org>/pulsify-db-bench:latest
unikraft volume create --metro fra --name pulsify-bench-data --size 1GiB
unikraft run --metro fra --name pulsify-db-bench --autostart -m 4GiB --vcpus 1 \
  -e "BENCH_BACKENDS=sqlite rocksdb postgres" \
  -e "BENCH_ARGS=--concurrency 1,16,128 --requests 1000 --modes saturation --scenarios mixed,read_delta,read_full,write_patch,compact,write_full" \
  -p 443:8080/http+tls --scale-to-zero policy=off --restart never \
  -v pulsify-bench-data:/data --image <org>/pulsify-db-bench:latest
# Reports appear at https://<fqdn>/unikraft-<tier>-<engine>.json.gz; /DONE marks the end.
```

Put the reports in a results directory, run `bun
benchmarks/database/native-fixtures.ts verify <report>` on each and delete the
instance and volume. The instance has one vCPU: client threads and the
database share it. Its root filesystem lives in RAM; only `/data` is a disk.
Mixed runs first because a full-write cell stores about 270 MiB per 1,000
requests and the volume is 1 GiB.

On a host with no Docker, the embedded engines only need the staged binary and
fixture: `pulsify-db-bench --backend rocksdb --environment vps --fixture
fixture.json --output vps-strict-rocksdb.json --data-path work/rocksdb ...`.

## Docker memory limits

Docker server and runner containers have **4 GiB RAM and no swap** each.
Effective limits and final server state (including OOMKilled) are saved before
cleanup. The retained medium run predates this guard and used the VM defaults;
its original Compose configuration is archived with the results.

After a fatal or interrupted series, fresh isolated probes test the remaining
operation groups. Those scores stay separate: fresh table state can behave very
differently from a table containing prior full writes, deletions and tombstones.
For example, a single fresh mixed cell can be run with `--scenarios mixed
--topologies hot --modes saturation`; use a new results directory. Failed cells
without a checkpoint are never counted as zero errors or successful requests.

## Work and concurrency

The fixture is produced by the real typed Pulsify API, not invented operation
bytes. It uses the existing small/medium/large document profiles (20/100/1,000
historical edits, on documents of growing size) or the `edits-100`,
`edits-1000` and `edits-10000` profiles, where the document is the same
(256 paragraphs, 266 KiB) and only the length of its history changes. Each worker has a genuine separate Pulsify actor and a
pre-generated causal scalar-patch stream. The database stores isolated scopes
of the same logical fixture: repeated payloads are valid document copies, not
changed envelope IDs surrounding incompatible initial data.

Each cell has fresh logical state: its own documents, seeded before the timer
starts. Once they are seeded, and again when the cell ends, the engine finishes
outside the timer the work it deferred: a checkpoint for PostgreSQL and SQLite,
a memtable flush and the pending compactions for RocksDB, a compaction of the
cell's key range for LevelDB, a sync for LMDB. A cell therefore reads documents
that are persisted, and does not pay for its predecessor. By default a cell's
documents are then deleted, which does not reset physical files or remove all
tombstones; with `--keep-data` nothing is deleted and the database holds the
whole campaign. Accumulated physical history can affect later cells either way.
Its prebuilt request schedule is deterministically shuffled. The mix is exactly:

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

The non-SQL engines share one ordered key-value layout (`storage/kv.rs`): a
segment's key is `(sid, end)` in big-endian under its document. One actor's
segments are contiguous and never overlap, so "end after this clock" and "the
segment starting here" are forward range scans without a second index. Each
engine supplies its own document lock and atomic commit:

- **RocksDB:** `TransactionDB`. A writer takes the frontier row with
  `GetForUpdate`, which the database holds until commit; readers use a snapshot.
  Tuned as its own guide recommends for this data: one background thread per
  core, LZ4 compression with ZSTD on the last level, 10-bit Bloom filters, a
  block cache (`--cache-mib`), and blob files for values of 4 KiB or more, so
  that a 266 KiB document is written once instead of at every level.
- **RocksDB with a mutex (`rocksdb-mutex`):** the plain `DB` without the
  transaction layer. The document lock is a striped mutex in the runner and a
  transaction's writes are one write batch, exactly like the LevelDB adapter.
- **LMDB:** its single write transaction is the lock; readers never block.
- **LevelDB:** atomic write batches and snapshots, but no transactions and no
  lock manager. The document lock is a striped mutex in the runner, which is
  what RocksDB's `TransactionDB` supplies inside the library. It runs with
  RocksDB's default 64 MiB write buffer (its own default is 4 MiB), its
  standard Snappy compression, the same block cache size as RocksDB and 10,000
  open table files. It has no Bloom filters or blob files in this binding.
- **Valkey, Dragonfly:** one sorted set per document, scanned lexicographically.
  The lock is a one-token list a writer blocks on with `BLPOP`; its writes and
  the release are one `MULTI`/`EXEC`. A read is one server-side script.
- **ScyllaDB:** no interactive transactions. A writer reads the document's
  version and sends one conditional batch on the partition (a lightweight
  transaction); if the version moved it starts over, with jittered backoff.
  Optimistic retries are counted. A hot document wastes the losers' work.
- **ClickHouse:** no row locks and no transactions. The lock is a row in a
  KeeperMap table that only one inserter can create; a transaction's writes are
  one atomic INSERT into a ReplacingMergeTree, read back with `FINAL`. It is an
  analytical engine measured here for curiosity.

ScyllaDB and ClickHouse readers have no snapshot spanning two queries. They
read the frontier first and the segments after: a delta can then hold rows newer
than its frontier, never fewer.

All backends use binary Pulsify frames in indexed per-actor segments and
transactional contiguous clocks. SQL uses relational segment tables. PostgreSQL
uses a connection per worker and a document advisory transaction lock for
writes; reads use read-only repeatable-read transactions without that lock.
SQL statements are cached per connection, and append reads/updates the complete
frontier once per transaction. Full reads avoid an empty-vector join; SQLite
materializes a nonempty remote-vector CTE once per query.
SQLite uses WAL, `synchronous=FULL`, one connection per worker, immediate write
transactions, deferred read transactions, a 64 MiB read-only mmap limit by
default (the library is compiled to accept up to 1 TiB), a 64 MiB page cache per
connection, a checkpoint every 64 MiB of log and a
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
In Docker it uses 180 allowed connections, 128 MiB shared buffers, a 128 MiB
WAL target, 32 MiB minimum WAL and a 60-second checkpoint interval; the
dedicated server has its own settings, listed above. Checkpoints run outside
cell timing.
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
| `engines.ts` | Engine identities and Docker images |
| `native-compose.yaml` | Isolated Docker server configuration |
| `native.ts` | Docker setup, builds, provenance and cleanup |
| `dedicated/setup.sh` | Prepare a dedicated Linux server |
| `dedicated/campaign.sh` | One engine's whole matrix on that server |
| `dedicated/report.ts`, `dedicated/campaign.ts` | `RESULTS.md` from a campaign's raw reports and `RESULTS.intro.md` |
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
Its historical tests and baseline are intentionally preserved.
