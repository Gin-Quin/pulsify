# Native Pulsify core: measured results

The independent native core wins **14 of the 18 existing primary scenarios** against json-joy on this machine. The unweighted geometric mean of `json-joy median time / Pulsify median time` is **1.559×**. All 18 cases, including the slower ones, enter that aggregate with equal weight.

Four cases remain slower: cached scalar reads, editable-object appends, 100-edit offline merges and a 16-peer conflict. This result is a local comparison of the documented tasks, not a claim that every operation, workload or machine is faster.

## Reproduce and inspect

```sh
bun run test:crdt
bun run bench:crdt --output benchmarks/results/core-native-repeat.json --markdown benchmarks/results/core-native-repeat.md
bun run bench:compare benchmarks/baselines/core-native-20261104.json benchmarks/results/core-native-repeat.json --strict
```

Measured at **2026-11-04T04:25:06.313Z**, from clean source commit `713b7db54c01dfb176deb8efb65cb0e3251b40ad` (`dirty: false`). Environment: Apple M4, arm64, darwin 25.3.0; bun-1.4.4, codec 2.1.0, json-joy 18.28.0, Yjs 13.6.33, Loro 1.17.1 (wasm-nodejs).

The full run has five warmup samples followed by 25 measured samples, seeded shuffled participant blocks and fresh replicas. Fixture setup, GC, verification and cleanup are outside timing. Created replicas stay alive through timing. Other benchmark campaigns in this session were paused; this was a local developer machine rather than an isolated performance runner.

- [All 95 raw measurements](baselines/core-native-20261104.json).
- [Generated comparison, sizes, p95 values and scenario definitions](CRDT-COMPARISON.md).
- [Harness method and regression policy](README.md).
- [Previous clean snapshot and baseline provenance](CORE-BASELINE.md).

## Aggregate comparison

| Comparator | Primary cases | Pulsify median wins | Geometric median speedup | Geometric p95-of-means ratio |
| --- | ---: | ---: | ---: | ---: |
| json-joy native | 18 | 14 | 1.559× | 1.459× |
| Yjs V2 | 18 | 16 | 1.889× | 1.676× |
| Loro Node WASM | 18 | 17 | 5.561× | 4.920× |

Each ratio is `comparator time / Pulsify time`; above one favors Pulsify. The geometric mean gives every existing case equal weight, including each document size and each history size. It is not weighted by a production traffic distribution. Yjs V1 is also reported for serialization scenarios in the full comparison, but has no complete 18-case aggregate.

The durations are medians and p95 values of **per-sample average operation times**, not percentiles of individual requests or events. The run does not provide confidence intervals. Small nominal margins can reverse with scheduling or JIT noise: initial-load/10 wins by about 1.8%, create+encode/10 by about 3.2%, and local-mutation differences are tens of nanoseconds. Do not rerun selectively to increase the victory count or treat these margins as statistically established.

## All 18 primary cases and the previous engine

Times below are µs per operation. The old Pulsify column comes from the clean `fab84ad` snapshot before the rewrite. Json-joy values come from the same final run as the new Pulsify values. P95 columns refer to sample means.

| Scenario | Old Pulsify | Native Pulsify | json-joy | json-joy / native | Native p95 | json-joy p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `create/10` | 13.769 | 7.708 | 10.163 | 1.318× | 17.652 | 18.119 |
| `create+encode/10` | 20.865 | 11.354 | 11.706 | 1.031× | 16.915 | 17.113 |
| `create/1000` | 446.646 | 250.646 | 425.521 | 1.698× | 338.104 | 467.084 |
| `create+encode/1000` | 862.021 | 293.583 | 669.875 | 2.282× | 328.187 | 724.500 |
| `export-first/1000` | 385.250 | 57.417 | 266.667 | 4.644× | 75.833 | 311.584 |
| `export-repeat/1000` | 21.167 | 14.333 | 248.333 | 17.326× | 20.542 | 271.000 |
| `read-count/10` | 0.0936 | 0.0185 | 0.0066 | 0.355× | 0.0251 | 0.0072 |
| `mutate/history-0` | 1.683 | 0.2675 | 0.3446 | 1.288× | 0.3052 | 0.4310 |
| `mutate/history-1000` | 1.487 | 0.2521 | 0.2856 | 1.133× | 0.3144 | 0.3523 |
| `mutate/history-5000` | 1.280 | 0.2346 | 0.2565 | 1.093× | 0.2846 | 0.3121 |
| `list-append/10` | 9.184 | 1.027 | 0.9354 | 0.911× | 1.878 | 1.416 |
| `edit+encode/10` | 3.024 | 1.294 | 2.591 | 2.003× | 1.784 | 3.600 |
| `delta-roundtrip/10` | 8.602 | 3.188 | 4.262 | 1.337× | 3.862 | 4.932 |
| `delta-roundtrip/1000` | 22.783 | 10.283 | 146.050 | 14.203× | 12.025 | 168.242 |
| `initial-load+materialize/10` | 35.663 | 13.800 | 14.050 | 1.018× | 16.767 | 16.963 |
| `initial-load+materialize/1000` | 1833.250 | 364.292 | 648.167 | 1.779× | 406.729 | 687.479 |
| `offline-merge/100-per-peer` | 639.958 | 423.333 | 85.708 | 0.202× | 452.042 | 106.916 |
| `upstream-map-conflict/16-peers` | 127.750 | 64.375 | 62.666 | 0.973× | 83.542 | 79.917 |

The old engine won 2/18 cases against its same-run json-joy reference. The geometric improvement from old Pulsify timings to the native engine timings is **3.134×**. Both runs used the same machine, library versions and unchanged workload shapes, but the implementation and schema parameters changed intentionally. The old report is [core-start-20261104.json](baselines/core-start-20261104.json); do not feed that cross-engine comparison to the strict same-implementation regression checker.

The strongest current advantages are full export and large-document incremental sync. A 1000-item first export takes about 57µs rather than 267µs, repeated export about 14µs rather than 248µs, and a large-document delta round trip about 10µs rather than 146µs. These task ratios include each engine’s retained representation and caches.

## Remaining losses and representation costs

- **Cached reads:** 18.55 ns versus 6.59 ns for native json-joy. The roughly 12 ns difference includes the proxy and attachment checks. The ratio is large because both absolute costs are small.
- **Append:** 1.027 µs versus 0.935 µs, about 9.8% slower. Both append a new editable two-field object and commit once.
- **16-peer conflict:** 64.375 µs versus 62.666 µs, about 2.7% slower. This is close to parity on this run, not an established tie or win.
- **Offline merge:** 423.333 µs versus 85.708 µs, about 4.94× slower. Pulsify encodes and imports every retained operation row; json-joy can export compact structural changes. This is the major remaining performance deficit.

| Transfer task | Pulsify bytes | json-joy bytes |
| --- | ---: | ---: |
| `create+encode/10` | 284.00 | 439.00 |
| `create+encode/1000` | 17027.00 | 36766.00 |
| `edit+encode/10` | 104.00 | 58.79 |
| `delta-roundtrip/1000` | 104.00 | 70.60 |
| `offline-merge/100-per-peer` | 17334.00 | 139.00 |
| `upstream-map-conflict/16-peers` | 1728.00 | 1024.00 |

Payload numbers exclude TCP/WebSocket/TLS. Pulsify includes its document/vector envelope; competitors use their native snapshot/update formats. Initial typed representations are smaller here, but small deltas and the offline history transfer can be larger. For offline merge, the bytes are the sum of both directions; for the conflict, they are all updates imported by one peer.

Pulsify retains immutable causal rows and overwritten writes. Json-joy exports structural snapshots/deltas; Yjs uses its default GC; Loro uses snapshots with history and updates. None is given an additional history-restoration service merely to match another format. These are meaningful default task comparisons, not identical retention guarantees. Safe compaction or a separately versioned grouped encoding would need its own correctness work before reducing Pulsify history transfer.

## Fairness and limits

- Fixture shape, iteration counts, transaction boundaries and timed portions are unchanged. Every nested map and array item remains an editable CRDT value. Strings in this suite are atomic values in all engines.
- Pulsify now receives its codec schema explicitly, compiled outside sample timing. The native json-joy graph constructor is the preserved pre-rewrite benchmark helper. Supplying schema information is an intended product capability, not a change to the input data.
- Cached nested references are resolved outside scalar loops. The public and direct Pulsify paths call the same guarded `CoreModel.set` and journal pipeline; the adapter test still requires identical states and encoded histories.
- First and repeated export remain separate. Packets from those dedicated export cases are imported and checked outside timing. Creation/encoding cases check the resulting document, with binary synchronization also covered by adapter tests. Initial loading includes a fresh receiver and detached snapshot; destruction stays outside timing.
- The native fast paths retain key, attachment, constant, value/schema, metadata, causal-reference and immutable-history checks. Their correctness is verified separately from timings.
- The suite times CPU-only engine exchange. Network transport, acknowledgement, authentication, durable storage and process startup are outside this comparison.
- Rich text, constants, migrations and materialization are tested features but are not comprehensively benchmarked by these 18 tasks. PostgreSQL, SQLite and FoundationDB integration checks are separate; [PostgreSQL measurements](../docs/STORAGE-BENCHMARKS.md) do not enter this aggregate.
- The suite does not rank total memory across JavaScript and WASM or claim best performance on every scale. Its source, environment, payloads and remaining losses define the practical limits of the result.

## Correctness and compatibility checks

The final source checks passed independently of this timing run:

- `bun run check`: 301 package tests passed, with two external-database suites explicitly skipped in the ordinary run; all 14 CRDT adapter tests also passed.
- Actual PostgreSQL, SQLite and FoundationDB integration: 39 tests and 201 assertions passed. This exercised the final storage hardening before formatting; the ordinary-run skips do not stand in for those real integrations.
- Rust protocol: five tests passed; TypeScript/Rust interoperability: three tests passed.
- The build and packed tarball passed strict NodeNext declaration checks and a Node consumer. The runtime matrix passed in Bun, Node, Deno and Chromium, and the two-browser-tab example passed synchronization and offline reconnection.
- Compatibility against the local codec checkout passed nine fixtures and document synchronization.

The new native engine has no runtime json-joy or Yjs dependency. It uses
envelope version 1 with operation payload **version 2**; payload version 1
from the previous json-joy engine is incompatible. Stored-data migrations
and a schema registry do not translate the old wire format. See the
[protocol contract](../docs/PROTOCOL.md) and
[database adapter guide](../docs/STORAGE.md) for deployment boundaries.
