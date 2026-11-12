> Archived before FoundationDB removal on 2026-11-04. Installation commands and source paths here describe the former implementation. Use [the current guide](../README.md) for runnable commands. Raw measurements are preserved.

# Native Rust database load results — 2026-11-04

The complete retained corpus contains **288 cells, 288,000 requests, 480 Pulsify model replays and 77,688 checked storage histories**. Every accepted patch and every historical row was preserved in the completed matrices. One compaction request exhausted the 32-plan retry budget in the medium profile; all 72,000 requests in the large profile completed without request errors.

All three clients are native Rust, including FoundationDB through foundationdb-rs 0.11.0 and C API 730. There is no Python bridge or per-key process transport. See the [methodology](FOUNDATIONDB-README.md), [complete medium table](../../baselines/database-native-20261104/medium/REPORT.md) and [complete large table](../../baselines/database-native-20261104/large/REPORT.md). Raw per-request reports are stored alongside those tables, gzip-compressed without dropping events.

## What was tested

Every cell issued 1,000 requests. The five isolated operations and the exact mixed distribution (45% patch append, 25% vector read, 10% initial full write, 10% full read, 10% compaction attempt) ran in both burst and saturation modes, on eight existing scopes or one hot scope. Full writes always create independent scopes. Pure spread compaction uses a fresh 33-row closed history per request, ensuring useful work. Mixed compaction operates on the full seeded history concurrently with reads and appends.

The medium profile uses 64 paragraphs and 100 historical edits, with 1/16/64 clients: 216 cells and 216,000 requests across the three databases. The large profile uses 256 paragraphs and 1,000 historical edits, with 128 clients: 72 cells and 72,000 requests. All 128 clients were observed active in each large mixed cell. These are different history sizes; joining them into a single concurrency scaling curve would be misleading.

## Large mixed workload at 128 clients

Saturation mode, successful requests/s and service p99 in milliseconds. The eight-scope pool still has contention at 128 clients.

| Deployment | Database | Eight scopes req/s | p99 ms | One hot scope req/s | p99 ms | Useful/noop hot compactions |
|---|---|---:|---:|---:|---:|---:|
| Docker Linux | PostgreSQL | 1220.4 | 520.3 | 580.9 | 801.6 | 5/95 |
| Docker Linux | FoundationDB | 155.0 | 5665.4 | 115.1 | 7891.7 | 2/98 |
| Docker Linux | SQLite | 418.1 | 1987.3 | 303.5 | 2466.1 | 49/51 |

PostgreSQL delivered the highest mixed throughput in this large-history reference implementation. SQLite's write transactions serialize across the entire file, including writes to different scopes. FoundationDB sustained the highest isolated patch rate, but its mixed workload was dominated by expensive history reads/compaction planning and overlapping maintenance requests. This is a measurement of these adapters and policies, not an intrinsic database ranking.

## The same hot mix as a 1,000-request burst

All requests arrive together. Service p99 includes database lock waits and retries; end-to-end p99 also includes the sender queue.

| Deployment | Database | req/s | Service p99 ms | Queue p99 ms | End-to-end p99 ms |
|---|---|---:|---:|---:|---:|
| Docker Linux | PostgreSQL | 556.2 | 908.6 | 1214.0 | 1792.9 |
| Docker Linux | FoundationDB | 117.7 | 7931.5 | 2875.6 | 8402.4 |
| Docker Linux | SQLite | 438.8 | 1659.5 | 1059.4 | 1729.3 |

## Every operation in isolation

Large profile, 128 clients, spread topology, saturation. Each entry is **req/s / service p99 ms**. Compaction entries below are all useful: 1,000 distinct seeded scopes, not repeated no-ops.

### Docker Linux

| Operation | PostgreSQL | FoundationDB | SQLite |
|---|---:|---:|---:|
| write_full | 1924.1 / 165.9 | 1061.7 / 325.2 | 137.9 / 5628.4 |
| read_full | 1177.5 / 298.8 | 295.9 / 493.2 | 1180.4 / 192.5 |
| write_patch | 2926.9 / 68.3 | 8441.0 / 41.8 | 231.7 / 3590.9 |
| compact | 653.0 / 461.1 | 390.0 / 472.8 | 145.5 / 5338.6 |
| read_delta | 4453.8 / 153.1 | 2742.5 / 55.5 | 1959.0 / 95.8 |

## Which operations slow down inside the hot mix

Large profile, 128 clients, saturation. These p99 values are **per operation**, not the aggregate mixed p99.

### Docker Linux

| Operation | PostgreSQL p99 ms | FoundationDB p99 ms | SQLite p99 ms |
|---|---:|---:|---:|
| write_patch | 473.6 | 133.0 | 2674.0 |
| read_delta | 64.9 | 614.8 | 173.0 |
| write_full | 101.5 | 80.2 | 2572.1 |
| read_full | 109.4 | 662.4 | 183.8 |
| compact | 900.0 | 7944.6 | 1964.0 |

FoundationDB's isolated patch append reached 8,441.0 req/s in the spread saturation case. In the hot mixed case, compaction p99 rose to about 7.9 seconds even though patch p99 stayed near 133 ms. The adapter fetches ranges per actor and currently performs that per-actor fan-out sequentially; a large frontier and repeated full-history compaction planning amplify the request count. Its explicit CAS retries also waste work when concurrent compactors choose the same source ranges.

The next implementation experiments should isolate per-actor range pipelining, metadata-only compaction selection, and a single compactor/lease per document or actor. Raising the retry budget alone would hide a rejection while potentially increasing tail latency. These are hypotheses supported by the access pattern and latency split, not a profiled attribution of every millisecond. The public production stores were not changed.

## Errors and integrity

The single request error occurred in the medium-profile FoundationDB hot mixed burst cell at 16 clients. It was an application compaction-plan retry-limit error, not a lost write or a failed actor-clock update. The exact failed event and all outliers remain in the raw reports. Retry totals omit an exhausted request's attempts and therefore undercount total retries when such an error occurs. PostgreSQL lock waits and SQLite busy-handler waits are reflected in latency, not explicit transaction-retry counts.

Every completed cell compared exact stored rows and the contiguous frontier against accepted appends. The artifact audit independently checked unique request IDs, exact 450/250/100/100/100 mixtures, raw success/error counts, finite timing values, queue/service arithmetic, active-client bounds, exact history-row totals and retained materialization proof counts. It covered 77,688 scoped histories. The 480 representative model replays imported actual Pulsify history in normal and reversed row order; their snapshots and vectors converged. No completed matrix lost history through compaction or concurrent append.

## Environment, provenance and interpretation

Host: Apple M4, 10 cores, 32 GiB RAM. Docker ran Linux ARM64 on OrbStack. PostgreSQL was 16.15; FoundationDB was 7.3.77; bundled SQLite was 3.51.1. Rust was 1.95.0. The runner image was sha256:88e30c447de1e520ccc3e1bf053260e58076f7c31fa01c835eabd2e5759ff267. PostgreSQL fsync, synchronous commits and full-page writes were enabled; SQLite used WAL and synchronous=FULL; FoundationDB used single ssd.

The medium cohort used a 1 GiB FoundationDB resident limit; the complete large FoundationDB cohort used 4 GiB. Both used 256 MiB storage memory and 128 MiB page cache. PostgreSQL used 128 MiB shared buffers, 180 allowed connections, a 128 MiB WAL target and explicit between-cell checkpoints. These are process/database settings, not equivalent cgroup-wide memory caps. Detailed settings, commands, timestamps and deployment provenance are in the context JSON files beside each cohort.

The base commit was 14cedc97860776e17c8e654b5f9d14c258756d46 with an uncommitted benchmark. All complete matrices used Rust-source SHA-256 6ae2eb3634a38b620b81bd92185751e568e1223e40aef23ac36c10b7ba34b327. Fixture hashes and commands are retained in each context. The matrices were collected in staged invocations, each recorded in a context file.

This is a finite-burst experiment on a shared development machine, not a long-duration capacity certification. Other applications/services and host memory pressure were present. Startup, generation, seeding, final verification and cleanup were outside timing, but background database maintenance and OS scheduling were not isolated. The mixed workload's amount of useful compaction changes with actor concurrency and races; use its useful/no-op counts when interpreting throughput. Do not extrapolate these figures to distributed FoundationDB, other schemas, stronger durability guarantees or arbitrary production workloads.

Reproduce into fresh directories with the commands in [the guide](FOUNDATIONDB-README.md). To reproduce the recorded medium memory ceiling, add --fdb-memory 1GiB; the default is now 4GiB for the large workload. Raw .json.gz files retain every measured request and can be fed directly to native-report.ts.
