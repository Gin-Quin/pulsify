# New storage engines, two durability tiers, four hosts — 2026-11-11

One campaign measures PostgreSQL 16 and SQLite again next to six new engines:
RocksDB and LMDB (embedded), Valkey and Dragonfly (in memory), ScyllaDB and
ClickHouse (curiosity). Every series uses the large profile (256 paragraphs,
1,000 historical edits), 1,000 requests per cell, 1/16/128 clients, saturation
mode, both topologies, with the mixed workload first. [Methodology, adapters
and durability tiers](../../database/README.md).

| Folder | Host | Engines |
|---|---|---|
| [mac-strict](mac-strict/REPORT.md), [mac-relaxed](mac-relaxed/REPORT.md) | Apple M4, macOS native and Docker (Linux VM, 4 GiB per container) | all eight in Docker; PostgreSQL, SQLite, RocksDB, LMDB native |
| [vps](vps/REPORT.md) | KVM VPS, 6 vCPU AMD EPYC, 11 GiB, Ubuntu 24.04 | SQLite, RocksDB, LMDB (no server installed there) |
| [unikraft](unikraft/REPORT.md) | Unikraft Cloud `fra`, 1 vCPU, 4 GiB, 1 GiB ext4 volume | PostgreSQL, SQLite, RocksDB |

## Mixed workload on one hot document

Successful requests/s at 1, 16 and 128 clients, then service p99 at 128 clients.

### Strict: flushed before the acknowledgement

| Host | Engine | 1 | 16 | 128 | p99 ms at 128 |
|---|---|---:|---:|---:|---:|
| macOS native | PostgreSQL | 1,186 | 2,358 | 2,313 | 176 |
| macOS native | SQLite | 2,409 | 2,988 | 1,511 | 540 |
| macOS native | RocksDB | 2,739 | 9,032 | 4,869 | 177 |
| macOS native | LMDB | 313 | 458 | 439 | 1,780 |
| Docker | PostgreSQL | 558 | 1,118 | 886 | 468 |
| Docker | SQLite | 728 | 393 | 484 | 1,784 |
| Docker | RocksDB | 947 | 719 | 1,692 | 442 |
| Docker | LMDB | 996 | 462 | 1,071 | 823 |
| Docker | Valkey | 588 | 450 | 586 | 846 |
| Docker | ScyllaDB | 121 | 17 | 6 (328 errors) | 40,726 |
| Docker | ClickHouse | 42 | 35 | 9 (362 errors) | 35,577 |
| VPS | SQLite | 315 | 124 | 51 | 18,643 |
| VPS | RocksDB | 300 | 273 | 215 | 3,551 |
| VPS | LMDB | 527 | 532 | 708 | 1,239 |
| Unikraft Cloud | PostgreSQL | 1,407 | 757 | 430 | 2,009 |
| Unikraft Cloud | SQLite | 2,499 | 1,228 | 727 | 1,261 |
| Unikraft Cloud | RocksDB | 2,224 | 1,700 | 1,590 | 453 |

### Relaxed: acknowledged first, flushed shortly after

| Host | Engine | 1 | 16 | 128 | p99 ms at 128 |
|---|---|---:|---:|---:|---:|
| macOS native | PostgreSQL | 948 | 2,181 | 1,797 | 195 |
| macOS native | SQLite | 2,074 | 2,336 | 1,130 | 850 |
| macOS native | RocksDB | 2,505 | 8,720 | 7,053 | 127 |
| macOS native | LMDB | 2,722 | 10,879 | 9,029 | 103 |
| Docker | PostgreSQL | 1,155 | 1,897 | 1,372 | 315 |
| Docker | SQLite | 2,005 | 2,636 | 1,391 | 688 |
| Docker | RocksDB | 2,219 | 6,610 | 5,948 | 107 |
| Docker | LMDB | 2,546 | 10,613 | 7,551 | 94 |
| Docker | Valkey | 1,492 | 1,156 | 1,125 | 380 |
| Docker | Dragonfly | 1,613 | 1,287 | 1,553 | 216 |
| Docker | ScyllaDB | 111 | 12 | 5 (errors) | 47,016 |
| Docker | ClickHouse | 79 | 73 | out of memory | not reached |
| VPS | SQLite | 910 | 463 | 128 | 7,262 |
| VPS | RocksDB | 1,165 | 1,155 | 1,532 | 588 |
| VPS | LMDB | 1,406 | 3,190 | 2,541 | 337 |
| Unikraft Cloud | PostgreSQL | 1,582 | 855 | 572 | 858 |
| Unikraft Cloud | SQLite | 3,036 | 2,086 | 1,675 | 476 |
| Unikraft Cloud | RocksDB | 3,313 | 2,486 | 1,843 | 505 |

Every operation, the spread topology and per-operation latencies inside the mix
are in each folder's report.

## RocksDB with and without its transaction layer, and LevelDB

[lsm-variants](lsm-variants/REPORT.md): three adapters in one session, in one
Linux container on the Mac pinned to one core (`--cpuset-cpus 0`; macOS cannot
pin a native process), then unpinned on ten. `rocksdb` is `TransactionDB`;
`rocksdb-mutex` is the plain `DB` with a mutex in the runner and one write batch
per transaction; LevelDB uses that same adapter shape. Requests/s at 1, 16 and
128 clients.

| One core | TransactionDB | RocksDB, mutex | LevelDB |
|---|---:|---:|---:|
| Strict, mixed, hot document | 841 / 1,195 / 700 | 1,081 / 977 / 797 | 1,008 / 1,098 / 1,024 |
| Relaxed, mixed, hot document | 3,031 / 2,186 / 1,876 | 3,032 / 2,193 / 1,357 | 3,225 / 2,383 / 1,766 |
| Relaxed, patch append, hot | 112,945 / 98,854 / 82,004 | 127,831 / 143,678 / 100,154 | 199,339 / 221,617 / 193,485 |
| Relaxed, full write, hot | 1,988 / 2,031 / 2,283 | 2,336 / 2,003 / 1,923 | 4,146 / 4,560 / 4,363 |

| Ten cores | TransactionDB | RocksDB, mutex | LevelDB |
|---|---:|---:|---:|
| Strict, mixed, hot document | 1,057 / 1,404 / 1,105 | 900 / 1,712 / 1,401 | 1,049 / 2,038 / 2,043 |
| Relaxed, mixed, hot document | 1,871 / 8,991 / 6,494 | 2,296 / 9,051 / 7,344 | 3,160 / 10,432 / 10,960 |
| Relaxed, patch append, hot | 106,088 / 101,024 / 53,862 | 143,214 / 146,133 / 107,748 | 197,912 / 237,035 / 154,134 |
| Relaxed, full write, hot | 2,829 / 2,895 / 1,202 | 4,006 / 3,988 / 4,103 | 6,567 / 5,486 / 5,933 |

- **The mix does not separate them on one core.** Reads and compaction spend
  the core in the runner (decoding, checksums, zlib), not in the engine, and the
  three adapters land within the noise of a single run.
- **Dropping `TransactionDB` helps relaxed appends**: 13% to 45% on one core, up
  to twice at 128 clients on ten. It does not help full writes on one core.
- **LevelDB stays ahead of both RocksDB adapters on isolated relaxed writes**,
  by about half again to twice. The transaction layer is therefore not the main
  reason; this campaign does not establish what is.
- **Strict cells are too noisy to rank here.** Between this session and
  [the earlier one](single-core/REPORT.md) (RocksDB and LevelDB only), the same
  `TransactionDB` cell moved by up to 25%, and one strict cell of the mutex
  adapter stalled at 38 requests/s.

LevelDB runs with RocksDB's 64 MiB write buffer and without compression; its
bundled Snappy collides with RocksDB's at link time. The runner image was
rebuilt with Clang for these sessions, so their RocksDB numbers differ from the
Docker rows above by more than the engine does.

## Reading these numbers

- **One run per cell.** These are finite 1,000-request batches, not repeated
  campaigns: differences under roughly 20% are not a ranking. On macOS the two
  tiers of PostgreSQL and SQLite differ by less than that noise.
- **macOS strict is not strict.** `fsync` there does not empty the drive cache.
  LMDB alone asks for a full flush, which is why its native strict numbers are
  5 to 20 times below its relaxed ones. Judge the strict tier on Linux.
- **Not comparable with the 2026-11-04 campaign.** The mix now runs first, on a
  fresh store; it ran last then. PostgreSQL and SQLite were measured again here
  so that every row of a table shares one day, host and order.
- **Unikraft Cloud has one vCPU.** Clients and database share it, so an engine
  inside the runner process avoids the context switches a server pays.
  Whether its volume's `fsync` reaches stable storage is not established.
- **The VPS is a shared machine** with other workloads and a disk 97% full. It
  has no Docker and no database server: only the embedded engines ran there.
- **Valkey and Dragonfly hold everything in RAM.** Dragonfly's append-only file
  has no flush-before-reply mode, so it has no strict row. In Docker it needs
  `seccomp=unconfined` for io_uring.
- **ScyllaDB and ClickHouse** have no interactive transactions. ScyllaDB
  retries conditional batches (thousands of retries at 16 clients on one
  document); ClickHouse queues on a KeeperMap lock and exhausted its 4 GiB
  container at 128 clients. Both are adapter measurements of a workload they
  were not designed for.

## Completeness

All matrices are 36 cells (3 client counts × 6 scenarios × 2 topologies) except:

| Series | Cells | Why |
|---|---:|---|
| mac-strict ScyllaDB | 6 | Mixed only, rerun with 30 s server timeouts. The first attempt stopped after 8 cells on a Paxos write timeout: [supplemental](mac-strict/supplemental). |
| mac-strict ClickHouse | 32 | Connection failure at 128 clients after lock timeouts. |
| mac-relaxed ScyllaDB | 31 | Stopped by the two-hour limit of the session that ran it, not by the engine. |
| mac-relaxed ClickHouse | 5 | Mixed only; memory limit exceeded at 128 clients on the hot document. |
| mac-relaxed Dragonfly | 36 | Rerun alone: the first start failed without io_uring. |

`context.json` in each Mac folder records the first invocation, including the
failures above; `context-*.json` records the reruns. Request errors: 3 SQLite
compactions on the VPS (30 s busy deadline), 2 PostgreSQL compactions per tier
on the Mac (retry budget), and the ScyllaDB and ClickHouse errors shown above.
Every completed cell was checked row for row in Rust, and its representative
histories were replayed through Pulsify.

The adapter sources were formatted with rustfmt and a callback type was named
after the campaign, without changing behaviour: `sourceSha256` in the contexts
identifies the measured sources, not the committed ones.
