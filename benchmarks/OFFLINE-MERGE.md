# Offline merge: exact-history pipeline improvements

The current workload retains and transfers **200 immutable transactions** (100
per peer). Json-joy's structural delta condenses the overwritten registers. This
explains both the CPU gap and **17,334 versus 139 bytes**. Detached snapshots
account for only about 8 µs of the instrumented Pulsify exchange. No transaction,
history row, value check or timed step was removed by this change.

The incremental improvement is confirmed, but **parity is not achieved**. In the
complete campaigns, Pulsify decreased from **395.416 to 333.375 µs** (15.7%);
same-run json-joy measured 75.209 and 70.583 µs respectively. Pulsify therefore
remains about **4.72× slower** in the final campaign. These are local sample-mean
medians, not individual request latency percentiles or confidence intervals.

## Changes and invariants

- Cache three repeated register-header strings on encode and three on decode.
  Each slot holds at most 1 KiB of owned bytes (six KiB total, plus the strings).
  Decoding compares every byte before reusing a string. Oversized strings follow
  the original codec path. Buffer slices are copied into plain Uint8Arrays.
- Construct decoded register writes directly and avoid a map for a single
  operation. Empty marker lists need no marker walk; every nonempty constant or
  rich-text marker list still passes `validatePrepared`.
- Copy journal rows directly into their final object shape. Dependency tuples
  and operation bytes remain independent copies, including the lazy public path.

The envelope, payload version, exact bytes, transaction identities, causal
dependencies, journal quotas, schemas, migrations, constants, rich text and
snapshot behavior are unchanged. This is a pipeline optimization, not compaction.

## Matched measurements

Machine: Apple M4, arm64, Darwin 25.3.0; Bun 1.4.4; codec 2.1.0; json-joy
18.28.0; Yjs 13.6.33; Loro 1.17.1. No concurrent benchmark campaign ran. Source
before the change is `b46e6413bf635130ee91352c5ab9bfcfe2cf3f72`, exported with
`git archive` into a temporary directory using the same installed dependencies.
Consequently the unmodified before-report's git commit field is empty; its
source provenance is this archive, not an unknown revision. After reports have
that base commit and `dirty: true`. This directory was never checked out over the
working tree. Harness, fixture and iteration parameters match.

Four independent filtered pairs ran in AB / BA / AB / BA order. Each process
used the normal five warmup and 25 measured samples and all five participants.
Times below are µs; all eight Pulsify reports retain 17,334 bytes.

| Pair | Pulsify before | Pulsify after | Decrease | json-joy before | json-joy after |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 424.542 | 360.667 | 15.0% | 128.625 | 126.458 |
| 2 | 404.834 | 362.709 | 10.4% | 134.292 | 127.834 |
| 3 | 412.417 | 364.374 | 11.6% | 127.542 | 125.500 |
| 4 | 412.500 | 365.541 | 11.4% | 129.167 | 133.209 |

The complete 95-case campaigns ran after then before. The strict same-environment
regression comparison passed with no flagged regressions. The complete suite
warms different paths from a filtered process, so do not substitute filtered
json-joy values into the complete comparison.

- [Complete before report](baselines/offline-incremental-20261104/full-before.json)
- [Complete after report](baselines/offline-incremental-20261104/full-after.json)
- [All alternating reports and their parameters](baselines/offline-incremental-20261104/alternating.json)

## Phase diagnosis, separate from the comparison

[`offline-merge-profile.ts`](offline-merge-profile.ts) mirrors the normal fixture
and exchange, with fresh peers and 100 actual commits each. It places nested
timers around actual codec, journal, preflight and model methods. These timers
perturb execution and JIT; their totals are **diagnostic**, not extra benchmark
wins. Per-phase medians need not add to the total median. Value encode is included
in missing rows; value decode is included in patch decode/runtime. Journal and
preflight exclusive values subtract their nested timed calls per sample.

| Diagnostic phase, both directions (µs) | Before | After |
| --- | ---: | ---: |
| Missing rows, including deferred payload encoding and copies | 115.917 | 110.667 |
| Envelope encoding and chunking | 52.958 | 51.417 |
| Envelope decoding and envelope checks | 59.874 | 61.917 |
| Patch decoding and runtime bookkeeping | 136.355 | 98.822 |
| Journal, excluding model preflight | 53.791 | 49.458 |
| Model preflight | 26.458 | 16.250 |
| Model application | 24.998 | 21.422 |
| Detached snapshots | 8.083 | 7.417 |
| Instrumented exchange total | 472.375 | 411.000 |

No new application graph is built in the timed merge: the initialized graphs
exist before timing and these incoming edits are scalar register writes.
The remaining cost is overwhelmingly the repeated representation and processing
of the exact history, rather than materialization or proxy access.

- [Before phase samples](baselines/offline-incremental-20261104/profile-before.json)
- [After phase samples](baselines/offline-incremental-20261104/profile-after.json)

## Verification and reproduction

`bun run check` passed: typecheck, 304 package tests and 14 adapter tests. Two
external database suites were skipped by the ordinary test command. Added codec
checks cover exact reference bytes, cache-hit/miss/oversized headers, Unicode,
Buffer mutation, warmed-cache truncations, malformed lengths and field tags, and
alternation between string and numeric fields. Existing journal tests check
duplicates, ownership, forks, gaps, history quotas and atomic rejection.

```sh
bun run check
bun benchmarks/offline-merge-profile.ts benchmarks/results/offline-profile.json
bun benchmarks/crdt-comparison.ts --output benchmarks/results/offline-full.json --markdown benchmarks/results/offline-full.md
bun benchmarks/compare.ts benchmarks/baselines/offline-incremental-20261104/full-before.json benchmarks/results/offline-full.json --strict
```

A further reduction requires an exact grouped representation and a group-aware
history path, with explicit capability negotiation and relay/storage support.
Simply keeping the last write would change the retention guarantee and is not
the optimization implemented here.
