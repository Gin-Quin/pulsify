# Mixed workload optimization — 2026-11-04

The **+30% throughput target is exceeded in every large-profile, 128-client mixed cell**, for both PostgreSQL and SQLite. The comparison is one baseline/optimized pair of Docker campaigns with identical fixture bytes; a single pair says little about variance.

| Deployment / engine | Throughput gain across spread/hot × burst/saturation |
|---|---:|
| Docker PostgreSQL | +30.4% to +74.1% |
| Docker SQLite | +69.6% to +110.6% |

See the audited [Docker comparison](DOCKER-COMPARISON.md). p99 service latency falls in all eight cells. In the hot saturation case, PostgreSQL goes from 655.6 to 876.0 req/s, and SQLite from 459.3 to 778.9 req/s.

## Changes retained

- **Both adapters:** append fetches the entire frontier once, validates dependencies in memory under the existing database write lock, and writes the frontier once. It still handles duplicate/conflicting rows, gaps, rollback and actor limits. The actor limit now counts the complete stored frontier, rather than only actors touched by the current append.
- **PostgreSQL:** each connection caches parameterized prepared statements. This reduces parse/plan/protocol work; it does not replace database locking with a process mutex. Read transactions still use repeatable read.
- **SQLite:** point lookups, inserts, vector access and range operations use `prepare_cached`. Full reads avoid the empty-vector join, and delta reads materialize their remote-vector CTE once. The same full-read specialization is used by PostgreSQL.
- **Compaction:** validate each selected actor range with one indexed SELECT, comparing complete metadata and payloads, then delete it with one indexed DELETE. All ranges are checked before any mutation. A delete-count mismatch fails and rolls back. Planning keeps a contiguous raw range, preserves the latest segment, retains already compressed data and keeps the 256 KiB/zlib-6 policy.
- **SQLite contention:** a native busy handler sleeps for a jittered 100–999 µs between lock attempts, bounded by a 30-second wall-clock deadline. SQLite remains responsible for write serialization. The old handler is selectable with `--sqlite-busy timeout`.
- **SQLite reads:** a 64 MiB mmap limit reduces read copies. `--sqlite-mmap-bytes 0` restores unmapped reads. The exact effective settings and busy policy are now recorded in raw reports.

PostgreSQL server configuration, WAL policy, fsync, synchronous commits and full-page writes were kept unchanged. SQLite remains WAL + `synchronous=FULL`. No operation share was reduced, reads still verify checksums/decode/coverage, and compaction still preserves every exact history row. These changes are in the Rust storage benchmark adapters; the production TypeScript stores and Pulsify wire format were not changed by this optimization work.

The implementation follows upstream documentation on [PostgreSQL prepared statements](https://www.postgresql.org/docs/16/sql-prepare.html), [SQLite busy callbacks](https://www.sqlite.org/c3ref/busy_handler.html), [busy timeouts](https://www.sqlite.org/c3ref/busy_timeout.html) and [memory-mapped reads](https://www.sqlite.org/mmap.html). Shorter waits can increase wakeups and CPU use; the measured improvement is throughput/latency, not a claim of lower CPU cost.

## Maintenance work

Useful compactions vary with scheduling. Optimized Docker SQLite removes about 0.5–4% fewer segments than the baseline depending on the cell, while preserving all rows. The reports show both useful/no-op attempts and removed segments, so a change in maintenance work is visible; the throughput gain must not be read as an equal gain in useful compactions/s.

## Evidence and verification

The Docker comparison audits **16,000 requests, 32 Pulsify materialization proofs and 1,672 exact scoped histories**, with zero request errors. Every measured cell also checks all accepted rows and the stored vector in Rust, outside timing. The mix remains exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads and 10% compaction attempts.

The live contract was extended with payload/metadata mismatches in a range, concurrent tail preservation, stale range rejection, rollback after a delete-count mismatch, and simultaneous appenders/compactors. It runs before every optimized backend campaign. The Rust unit suite, TypeScript typecheck, database benchmark tests and real PostgreSQL/SQLite production storage tests pass. Clippy completes with the existing worker-return-type complexity warning; strict `-D warnings` reports that unchanged warning. The optional PostgreSQL Rust unit test is skipped without `PULSIFY_NATIVE_PG_URL`; all PostgreSQL campaigns run the actual live contract independently.

Retained campaigns: `baseline-docker` versus `optimized-docker`, with their raw per-request results.

The complete initial Rust sources/manifests and initial orchestration files are saved under `baseline-source`; final sources are under `optimized-source`. The protocol crate is unchanged from the repository revision recorded in context. Every completed campaign retains source/fixture hashes, exact command, hardware, effective database settings, memory/disk snapshots and raw per-request events. Docker servers and runners were bounded to 4 GiB RAM each, without swap.

These are finite 1,000-request batches in Docker on a shared Apple Silicon workstation. They are not a long-running capacity or crash-recovery certification.

## Reproduce

Use fresh result directories. No production database is involved.

```sh
bun run bench:database --environment docker --profile large \
  --databases postgres,sqlite --concurrency 128 --requests 1000 --scenarios mixed \
  --results-dir benchmarks/results/mix-optimized-1
# Repeat with fresh directories.

# Restore standard SQLite waits and disable mmap for an ablation of those two knobs.
bun run bench:database --environment docker --profile large \
  --databases sqlite --concurrency 128 --requests 1000 --scenarios mixed \
  --sqlite-busy timeout --sqlite-mmap-bytes 0 \
  --results-dir benchmarks/results/mix-standard-waits

# Re-audit the retained results (run from repository root).
bun benchmarks/database/mix-comparison.ts \
  --baseline benchmarks/baselines/database-mix-optimization-20261104/baseline-docker \
  --candidate benchmarks/baselines/database-mix-optimization-20261104/optimized-docker \
  --output benchmarks/results/mix-comparison.md
```

To reconstruct the old implementation, use a separate copy of the repository: replace `crates/pulsify-db-bench/src`, `Cargo.toml` and `Cargo.lock` with `baseline-source` equivalents, and restore `baseline-source/orchestration/*` under `benchmarks/database/`. Keep `crates/pulsify-protocol` unchanged. TypeScript orchestration snapshots have an extra `.snapshot` suffix to keep historical imports out of the current TypeScript build; remove that suffix when restoring them. The original orchestrator accepts the same benchmark command except the two new SQLite flags. This reconstructs the recorded baseline source and orchestration hashes without overwriting current work.
