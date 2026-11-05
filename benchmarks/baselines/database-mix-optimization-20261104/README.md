# Mixed workload optimization — 2026-11-04

The **+30% throughput target is exceeded in every large-profile, 128-client mixed cell**, for both PostgreSQL and SQLite. The primary comparison uses three baseline and three optimized native campaigns with identical fixture bytes. The secondary Docker comparison is one baseline/optimized pair and is less conclusive about variance.

| Deployment / engine | Throughput gain across spread/hot × burst/saturation |
|---|---:|
| Native PostgreSQL | +88.6% to +191.3% |
| Native SQLite | +96.8% to +202.8% |
| Docker PostgreSQL | +30.4% to +74.1% |
| Docker SQLite | +69.6% to +110.6% |

See the audited [native comparison](COMPARISON.md), [Docker comparison](DOCKER-COMPARISON.md) and [medium comparison](MEDIUM-COMPARISON.md). Native large p99 service latency falls in all eight cells. In the hot saturation case, PostgreSQL goes from 1,190.2 to 2,244.1 req/s, and SQLite from 924.9 to 1,879.2 req/s.

**The gain is not universal across client counts.** The medium campaign (one before/after pair, 100 historical edits, 1/16/64 clients) exceeds 30% for every PostgreSQL cell and SQLite at 16/64 clients. SQLite with one client improves only 8.2–24.2%; the medium report deliberately retains a failed “every cell ≥30%” check. No regression was observed in that matrix.

## Changes retained

- **Both adapters:** append fetches the entire frontier once, validates dependencies in memory under the existing database write lock, and writes the frontier once. It still handles duplicate/conflicting rows, gaps, rollback and actor limits. The actor limit now counts the complete stored frontier, rather than only actors touched by the current append.
- **PostgreSQL:** each connection caches parameterized prepared statements. This reduces parse/plan/protocol work; it does not replace database locking with a process mutex. Read transactions still use repeatable read.
- **SQLite:** point lookups, inserts, vector access and range operations use `prepare_cached`. Full reads avoid the empty-vector join, and delta reads materialize their remote-vector CTE once. The same full-read specialization is used by PostgreSQL.
- **Compaction:** validate each selected actor range with one indexed SELECT, comparing complete metadata and payloads, then delete it with one indexed DELETE. All ranges are checked before any mutation. A delete-count mismatch fails and rolls back. Planning keeps a contiguous raw range, preserves the latest segment, retains already compressed data and keeps the 256 KiB/zlib-6 policy.
- **SQLite contention:** a native busy handler sleeps for a jittered 100–999 µs between lock attempts, bounded by a 30-second wall-clock deadline. SQLite remains responsible for write serialization. The old handler is selectable with `--sqlite-busy timeout`.
- **SQLite reads:** a 64 MiB mmap limit reduces read copies. `--sqlite-mmap-bytes 0` restores unmapped reads. The exact effective settings and busy policy are now recorded in raw reports.

PostgreSQL server configuration, WAL policy, fsync, synchronous commits and full-page writes were kept unchanged. SQLite remains WAL + `synchronous=FULL`. No operation share was reduced, reads still verify checksums/decode/coverage, and compaction still preserves every exact history row. These changes are in the Rust storage benchmark adapters; the production TypeScript stores and Pulsify wire format were not changed by this optimization work.

The implementation follows upstream documentation on [PostgreSQL prepared statements](https://www.postgresql.org/docs/16/sql-prepare.html), [SQLite busy callbacks](https://www.sqlite.org/c3ref/busy_handler.html), [busy timeouts](https://www.sqlite.org/c3ref/busy_timeout.html) and [memory-mapped reads](https://www.sqlite.org/mmap.html). Shorter waits can increase wakeups and CPU use; the measured improvement is throughput/latency, not a claim of lower CPU cost.

## Experiments

Exploratory runs are single campaigns, not statistical attribution of each individual change. Hot saturation at 128 clients:

| Cumulative change | PostgreSQL req/s | SQLite req/s |
|---|---:|---:|
| Baseline (median of 3) | 1,190.2 | 924.9 |
| Cached statements + frontier + specialized reads | 2,005.9 | 1,018.6 |
| Add range compaction | 2,460.8 | 714.8 |
| Add jittered SQLite busy handler | — | 1,420.2 |
| Add 64 MiB SQLite mmap | — | 1,827.8 |
| Final configuration (median of 3) | 2,244.1 | 1,879.2 |

The range rewrite alone did not improve SQLite hot contention in its exploratory run. It is retained with the complete configuration because its bulk validation preserves the contract, dramatically reduces PostgreSQL round trips and the final repeated SQLite scores exceed the target. The final SQLite configuration has more compaction-plan retries than the old timeout handler; these waits/retries remain inside the timer.

Useful compactions vary with scheduling. Final native SQLite removes about 1–7% fewer segments than the baseline depending on the cell, while preserving all rows. The reports show both useful/no-op attempts and removed segments, so a change in maintenance work is visible; the throughput gain must not be read as an equal gain in useful compactions/s.

## Evidence and verification

The primary native comparison audits **48,000 requests, 96 Pulsify materialization proofs and 5,016 exact scoped histories**, with zero request errors. The medium comparison adds 48,000 requests/96 proofs, and Docker adds 16,000 requests/32 proofs. Every measured cell also checks all accepted rows and the stored vector in Rust, outside timing. The mix remains exactly 45% patch writes, 25% vector reads, 10% full writes, 10% full reads and 10% compaction attempts.

The live contract was extended with payload/metadata mismatches in a range, concurrent tail preservation, stale range rejection, rollback after a delete-count mismatch, and simultaneous appenders/compactors. It runs before every optimized backend campaign. The Rust unit suite, TypeScript typecheck, database benchmark tests and real PostgreSQL/SQLite production storage tests pass. Clippy completes with the existing worker-return-type complexity warning; strict `-D warnings` reports that unchanged warning. The optional PostgreSQL Rust unit test is skipped without `PULSIFY_NATIVE_PG_URL`; all PostgreSQL campaigns run the actual live contract independently.

Primary native repetitions: `baseline-large-{1,2,3}` versus `optimized-large-{1,2,4}`. `optimized-large-3` is an additional successful validation run excluded from the primary medians because correctness tests were launched concurrently. All raw results are retained. `experiment-3-metadata-failure` and `baseline-large-3-fixture-failure` failed before timed cells and are not included in any score.

The complete initial Rust sources/manifests and initial orchestration files are saved under `baseline-source`. Intermediate Rust sources are retained in `experiment-1-source` and `experiment-2-source`; final sources are under `optimized-source`. The protocol crate is unchanged from the repository revision recorded in context. Every completed campaign retains source/fixture hashes, exact command, hardware, effective database settings, memory/disk snapshots and raw per-request events. Docker servers and runners were bounded to 4 GiB RAM each, without swap.

These are finite 1,000-request batches on a shared Apple Silicon workstation. They are not a long-running capacity or crash-recovery certification. Native and Docker have different filesystem/VM costs and must be compared within each deployment.

## Reproduce

Use fresh result directories. No production database is involved.

```sh
bun run bench:database --environment bare-metal --profile large \
  --databases postgres,sqlite --concurrency 128 --requests 1000 --scenarios mixed \
  --results-dir benchmarks/results/mix-optimized-1
# Repeat with fresh directories; use --environment docker for the Docker check.

# Restore standard SQLite waits and disable mmap for an ablation of those two knobs.
bun run bench:database --environment bare-metal --profile large \
  --databases sqlite --concurrency 128 --requests 1000 --scenarios mixed \
  --sqlite-busy timeout --sqlite-mmap-bytes 0 \
  --results-dir benchmarks/results/mix-standard-waits

# Re-audit the retained primary results (run from repository root).
bun benchmarks/database/mix-comparison.ts \
  --baseline benchmarks/baselines/database-mix-optimization-20261104/baseline-large-1 \
  --baseline benchmarks/baselines/database-mix-optimization-20261104/baseline-large-2 \
  --baseline benchmarks/baselines/database-mix-optimization-20261104/baseline-large-3 \
  --candidate benchmarks/baselines/database-mix-optimization-20261104/optimized-large-1 \
  --candidate benchmarks/baselines/database-mix-optimization-20261104/optimized-large-2 \
  --candidate benchmarks/baselines/database-mix-optimization-20261104/optimized-large-4 \
  --output benchmarks/results/mix-comparison.md
```

To reconstruct the old implementation, use a separate copy of the repository: replace `crates/pulsify-db-bench/src`, `Cargo.toml` and `Cargo.lock` with `baseline-source` equivalents, and restore `baseline-source/orchestration/*` under `benchmarks/database/`. Keep `crates/pulsify-protocol` unchanged. TypeScript orchestration snapshots have an extra `.snapshot` suffix to keep historical imports out of the current TypeScript build; remove that suffix when restoring them. The original orchestrator accepts the same benchmark command except the two new SQLite flags. This reconstructs the recorded baseline source and orchestration hashes without overwriting current work.
