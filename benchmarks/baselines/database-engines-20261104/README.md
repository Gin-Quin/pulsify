# Pulsify database engine campaign — 2026-11-04

Start with [the interpreted results](../../database/RESULTS.md) or
[the generated complete summary](SUMMARY.md).

- `medium/`: 1/16/64 clients; 432 completed cells, 432,000 requests, zero errors.
- `large-docker/`: 128 clients, 4 GiB/no swap per container; columnar series
  OOM-killed a server process. Other matrices completed.
- `supplemental/`: fresh isolated columnar probes, kept separate from the main
  series. 13 completed cells and two further OOM failures without a cell checkpoint.
- `failures/`: the excluded trial that ran under host memory pressure. Actual
  retained stress failures remain visible in the main summaries.
- `provenance/`: original uncapped Compose and orchestration snapshot.
- `validation/`, `VALIDATION.json`: test evidence and provenance/schema checks.

Raw `.json.gz` reports preserve per-request events, completed-cell verification
counts and model replay proofs. Gzip output is checked byte-for-byte before the
uncompressed file is removed. Recreate tables with:

```sh
bun benchmarks/database/native-report.ts benchmarks/baselines/database-engines-20261104/medium
bun benchmarks/database/native-summary.ts benchmarks/baselines/database-engines-20261104
```

Counts exclude uncheckpointed requests; an interrupted/OOM matrix is never
reported as a completed zero-error result. See [host interventions](INTERVENTIONS.md)
and [FoundationDB cleanup](FOUNDATIONDB-CLEANUP.md).

## Archive normalization

Personal home paths in the database campaign archives were normalized to
`/home/benchmark` before committing. Archived timings and measurements are
unchanged. `RESULTS-MANIFEST.json` records hashes of the normalized artifacts.
