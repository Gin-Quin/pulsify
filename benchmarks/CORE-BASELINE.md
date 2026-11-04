# Core rewrite baseline

The full existing CRDT comparison was run before changing the engine on
2026-11-04, at commit `fab84ad24de34ff79a9e25f6f2627f6ca2247a9f` with a clean
worktree. The 95 results, versions, environment, sample parameters and payload
sizes are preserved in [baselines/core-start-20261104.json](baselines/core-start-20261104.json).

```sh
bun run bench:crdt --output benchmarks/results/core-start-baseline.json --markdown benchmarks/results/core-start-baseline.md
bun test benchmarks/crdt-adapters.test.ts
```

All 14 adapter tests passed. This baseline uses the unchanged workloads: five
warmup and 25 measured samples, a fixed shuffled participant order, fresh state
per sample and cleanup outside timing. Values are medians of per-sample average
operation times, not individual-event latency percentiles.

| Selected scenario | Existing Pulsify, µs/op | json-joy, µs/op |
| --- | ---: | ---: |
| create/1000 | 446.65 | 428.06 |
| create+encode/1000 | 862.02 | 692.58 |
| export-first/1000 | 385.25 | 265.25 |
| export-repeat/1000 | 21.17 | 258.54 |
| read-count/10 | 0.094 | 0.006 |
| mutate/history-0 | 1.68 | 0.38 |
| mutate/history-5000 | 1.28 | 0.25 |
| list-append/10 | 9.18 | 1.14 |
| edit+encode/10 | 3.02 | 2.64 |
| delta-roundtrip/10 | 8.60 | 3.96 |
| delta-roundtrip/1000 | 22.78 | 145.42 |
| initial-load+materialize/1000 | 1833.25 | 663.10 |
| offline-merge/100-per-peer | 639.96 | 88.54 |
| upstream-map-conflict/16-peers | 127.75 | 48.96 |

The old engine beats json-joy in two of the 18 primary scenarios. Its retained
operation journal favors repeated exports and large-document incremental sync;
this does not imply faster local execution. The native json-joy comparison
uses its structural snapshots and deltas rather than retaining an additional
application journal.

## Fairness requirements for the replacement

- Keep fixture shape, iteration counts, transaction boundaries and timed
  portions unchanged. All nested maps and array items must remain editable;
  replacing them with opaque JSON constants is a different workload.
- Keep cached nested handles outside scalar read/write timing for every
  participant. Preserve first versus repeated export as separate cases.
- Keep import verification and source-input isolation checks. All exports
  must be usable by a fresh replica. Direct and proxy writes must produce
  identical document state and encoded histories for identical actors.
- Adapt the Pulsify direct path to the new engine's actual commit and journal
  path. At baseline capture it called json-joy's builder through `meta.mutate`;
  the replacement uses `CoreModel.set`. A direct mutation must not bypass
  services that the public proxy performs.
- Re-run the complete comparison after correctness tests and independent
  review. Use the same machine and parameters, with other CPU campaigns
  stopped. Single sub-microsecond samples are noisy; confirm close ratios.

The current suite does not compare rich-text editing, constant-field semantics,
schema compilation, database ingestion/query, migration, materialization or
adversarial missing/dependent operations. These require separate correctness
tests and clearly labeled supplementary measurements, not substitutions for
the existing 18 primary scenarios.
