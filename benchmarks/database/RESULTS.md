# Database engine load results

> **2026-11-11:** [six new engines, two durability tiers and four hosts](../baselines/database-engines-20261111/README.md)
> (RocksDB, LMDB, Valkey, Dragonfly, ScyllaDB, ClickHouse; macOS, Docker, a VPS
> and Unikraft Cloud). On the mixed workload with a 1,000-edit history and 128
> clients on one document, RocksDB leads the strict tier in Docker (1,692
> requests/s, PostgreSQL 886) and on Unikraft Cloud (1,590, PostgreSQL 430);
> LMDB leads the relaxed tier (7,551 in Docker). That campaign runs the mix
> first, so its numbers are not comparable with the ones below.

## 2026-11-04

> A later [mixed-workload optimization campaign](../baselines/database-mix-optimization-20261104/README.md) improves these Rust adapters. At 128 clients, repeated native mix throughput improves **89–191% for PostgreSQL and 97–203% for SQLite**; a separate Docker before/after pair also exceeds 30% in every cell. The results below are the original engine comparison and are retained unchanged. SQLite at one client improves only 8–24% in the new medium check.

The retained corpus has **957,000 checkpointed requests**: 934,000 in the main
series and 23,000 in fresh isolated probes. It contains **584 recorded request
errors**, **1,594 real Pulsify model replays**, and **255,960 exact storage
histories checked**. **18 of 20 main matrices completed**; both incomplete
matrices are pgrust columnar at 128 clients. Requests interrupted before a cell
checkpoint are not counted as successful requests or zero errors.

The [full summary](../baselines/database-engines-20261104/SUMMARY.md) contains
all operation scores, concurrency scaling, burst latency, matrix status and
separate fresh-probe results. Detailed per-operation latencies inside the mix
are in the phase reports. [Methodology and commands](README.md).

## Heavy mixed load in Docker

Large history, **128 clients**, one hot scope, saturation mode, 1,000 requests.
The mix is exactly **45% patches, 25% vector reads, 10% full writes, 10% full
reads and 10% compaction attempts**. Docker containers have 4 GiB RAM each and
no swap. All 128 clients were observed active in these completed mixed cells.

| Engine | Successful req/s | Service p99 ms | Request errors |
|---|---:|---:|---:|
| PostgreSQL 16 | 638.8 | 700.5 | 0 |
| SQLite | 459.7 | 1,572.8 | 0 |
| AlloyDB Omni 17.10.0 | 521.3 | 895.4 | 0 |
| OrioleDB, PostgreSQL 17.11 / beta 19 | 407.9 | 1,530.1 | 0 |
| pgrust 0.4-beta, row tables | 684.1 | 709.1 | 0 |
| pgrust 0.4-beta, columnar tables | not reached | not reached | backend OOM |

These are measurements of the shared reference adapter and configured workload,
not engine throughput ceilings. Small differences in a single finite run do
not establish a general ranking. AlloyDB means **local Omni**, not the managed
Google Cloud product. Aurora was excluded by the requested open-source condition;
its proprietary nature is described in this [AWS-hosted article](https://builder.aws.com/content/2cHWoBmG2UJqZuQ8eEFtGiJ5NDd).

## What happened with columnar tables

Both tables use **pgrcolumnar**, checked through the system catalog. Non-unique
point `(doc,sid,start)` and end-range indexes serve the same lookups as the row
schema. The beta has no unique indexes or ON CONFLICT on columnar tables, so
its vector row uses locked transactional DELETE+INSERT. Actual index definitions
and effective settings are recorded in each raw report.

At 1/16/64 clients, **all 720,000 main-series requests completed without errors**,
including columnar storage. At 128 clients with the larger history:

- **Native columnar:** spread compaction completed 416 of 1,000 requests and
  recorded **584 SQL timeout errors**. Successful throughput was 1.7 req/s;
  service p99, including errors, was 82.1 seconds. An OS region sample showed
  about 24 GiB swapped memory; allocator-level inspection was incomplete.
  Cancellations released memory. The Mac subsequently rebooted; the cause of
  that reboot is not established. The native matrix has 13/24 checkpointed cells.
- **Docker columnar:** the main series reached 9/24 cells before a server
  process was OOM-killed inside its **4 GiB** limit and reinitialized. The
  client observed a connection reset. This is a fatal backend failure, even
  though completed cells before it show zero request errors.
- **Fresh isolated probes:** vector reads, hot compaction, remaining patch
  cases and the mixed workload passed. Fresh spread compaction over 1,000
  distinct histories reproduced OOM in **both burst and saturation** modes.

A fresh hot mixed cell produced **734.7 req/s / 596.8 ms p99 natively** and
**516.7 req/s / 993.1 ms p99 in Docker**, with no request errors. These are
separate fresh-instance observations, not substituted into the failed full
series. They show that a successful small-scope mix does not establish healthy
large-pool compaction or behavior after prior writes/deletions. Query shape,
dataset size and physical maintenance state matter; the root cause needs
further engine-level investigation.

See the [native incident](../baselines/database-engines-20261104/columnar-memory-incident.json),
[Docker state](../baselines/database-engines-20261104/large-docker/pgrust-columnar-container-state.json)
and [fresh probe outcomes](../baselines/database-engines-20261104/supplemental/attempts.json).

## Scope, evidence and validation

Native macOS ARM64 runs cover PostgreSQL, SQLite and both pgrust modes. Docker
ARM64 additionally covers Omni and OrioleDB. OrioleDB's tables really use
orioledb. Native Omni requires Linux; OrioleDB was not installed natively here.
The [official macOS development guide](https://www.orioledb.com/docs/contributing/local-builds)
starts by disabling SIP, which this campaign did not change.

The medium Docker run used default VM limits. Following the native memory
incident, the Docker large phase ran separately with uniform 4 GiB/no-swap
limits. These deployments and profile sizes must not be joined into one scaling
curve. The [intervention log](../baselines/database-engines-20261104/INTERVENTIONS.md)
keeps host-memory, schema-correction and reboot history explicit. Earlier
memory-pressured and missing-index trials are excluded from comparisons.

The Rust adapter uses application SQL transactions; the production PostgreSQL
adapter separately offers a one-call PL/pgSQL append path. Docker SQLite uses
the runner writable layer, while server engines use named volumes. Logical
cleanup uses DELETE + CHECKPOINT, retaining physical files/tombstones until the
engine reclaims them. Compaction is lossless and excludes the open write tail;
useful work and no-ops are counted separately. These finite batches do not
establish steady-state capacity, cloud-product performance or replicated/crash
recovery guarantees.

The [validation record](../baselines/database-engines-20261104/VALIDATION.json)
confirms identical large fixtures across invocations, one Rust source hash,
actual table/index methods and Docker limits. Checks passed: TypeScript/core
(332 passes, one optional PostgreSQL skip), 14 CRDT tests, seven benchmark
tests, four Rust unit tests, 31 actual PostgreSQL/SQLite storage checks, 12
legacy Docker conformance tests, build and packed-package NodeNext/Node checks.
Every measured backend also runs the real parallel storage contract first.
[Validation logs](../baselines/database-engines-20261104/validation/).

## FoundationDB removal

FoundationDB adapters, exports, bridges, SDK/setup scripts, native dependency,
binaries, library, specific Cargo caches, images and related Docker build cache
were removed. No FoundationDB daemon was installed or remains running.
[Cleanup audit](../baselines/database-engines-20261104/FOUNDATIONDB-CLEANUP.md).

Its [archived Rust results](archive/FOUNDATIONDB-RESULTS.md) and raw measurements
remain intact. FoundationDB's part recorded 192,000 requests and four exhausted
compaction retries in the medium profile. Its large hot mixed saturation was
122.5 req/s / 7,385.4 ms p99 natively and 115.1 req/s / 7,891.7 ms in Docker.
Those measurements already used the native Rust/C API client, without Python;
they are not silently merged into this new campaign.

## Post-campaign removal

AlloyDB Omni, OrioleDB and pgrust installations were removed at the user's request.
The three server images and native pgrust distribution/download were deleted.
All 268 indexed result/provenance artifacts were verified unchanged afterward;
failures and incomplete matrices remain recorded. See the
[removal audit](../baselines/database-engines-20261104/DATABASE-REMOVAL.md) and
[artifact manifest](../baselines/database-engines-20261104/RESULTS-MANIFEST.json).
