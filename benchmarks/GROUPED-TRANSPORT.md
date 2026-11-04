# Integrated grouped transport

Production integration measured at `876fb3d7453faf70315eef72d2b98ca8e49e4e04` with a clean worktree (`dirty: false`). Five warmup samples and 25 measured samples; all 95 comparison cases are retained. The experiment is now connected through the public API, Connection, memory/WebSocket transports, the reference relay, Rust input and all three durable adapters.

The current full campaign wins 15/18 primary median comparisons against json-joy; the unweighted geometric ratio is 1.743×. **Offline parity is not achieved in the production campaign**: Pulsify takes 178.125 µs versus json-joy 93.916 µs (1.90× slower), despite the earlier white-box prototype's favorable results. Do not report the prototype's timings as product timings.

## Measurements

| Scenario | Previous Pulsify | Grouped Pulsify | json-joy | Yjs V2 | Loro |
| --- | ---: | ---: | ---: | ---: | ---: |
| `create/10` | 9.240 | 9.435 | 11.090 | 13.592 | 52.965 |
| `create+encode/10` | 12.392 | 11.985 | 12.346 | 18.829 | 99.244 |
| `create/1000` | 257.604 | 273.896 | 475.458 | 335.521 | 3133.125 |
| `create+encode/1000` | 300.313 | 326.146 | 727.041 | 501.250 | 4807.708 |
| `export-first/1000` | 65.000 | 62.166 | 289.250 | 201.125 | 1729.583 |
| `export-repeat/1000` | 17.834 | 23.625 | 288.583 | 205.083 | 95.792 |
| `read-count/10` | 0.0179 | 0.0193 | 0.0068 | 0.0135 | 0.1284 |
| `mutate/history-0` | 0.2752 | 0.2037 | 0.3923 | 1.189 | 1.320 |
| `mutate/history-1000` | 0.2798 | 0.1556 | 0.2810 | 0.9160 | 1.292 |
| `mutate/history-5000` | 0.2602 | 0.1388 | 0.2840 | 0.9362 | 1.267 |
| `list-append/10` | 1.164 | 1.150 | 1.088 | 1.617 | 4.447 |
| `edit+encode/10` | 1.388 | 1.483 | 2.707 | 4.907 | 8.524 |
| `delta-roundtrip/10` | 3.174 | 3.343 | 4.549 | 8.230 | 16.805 |
| `delta-roundtrip/1000` | 10.767 | 12.292 | 159.892 | 30.725 | 50.750 |
| `initial-load+materialize/10` | 14.629 | 15.867 | 16.054 | 17.242 | 50.325 |
| `initial-load+materialize/1000` | 390.959 | 395.666 | 700.271 | 578.562 | 1701.500 |
| `offline-merge/100-per-peer` | 372.833 | 178.125 | 93.916 | 91.459 | 264.208 |
| `upstream-map-conflict/16-peers` | 53.417 | 61.917 | 71.500 | 102.042 | 396.125 |

Times are µs/op, medians of sample means. Previous Pulsify is the earlier full `92baffb` campaign on the same machine, with no production diff (only untracked prototype artifacts); its original `dirty: true` is preserved in the raw file. These are separate sessions, not a new matched A/B significance test. Json-joy/Yjs/Loro columns come from the same final campaign as grouped Pulsify. Small differences can be scheduling/JIT noise.

Offline transfer decreases from **17,334 to 2,246 bytes**, retaining all 200 edits plus the initial row. Current CPU time decreases from the previous campaign's 372.833 to 178.125 µs (52.2% observed reduction); the competitor control also changed from 91.25 to 93.916 µs. Encoding and receiving are still inside timing; no group was prepared during the 100 offline writes. The benchmark calls `exportPulseUpdates` / `applyPulseUpdates`, the same public exchange path used by Connection. Schema compilation remains outside timing as in the earlier comparison.

The production implementation deliberately keeps bounds, immutable public views, unknown-peer compatibility, ownership and fallback paths. The prototype is historical experimental evidence against `92baffb`, not an interchangeable implementation. The warm diagnostic profiler is separately instrumented and must not replace the complete comparison.

- [Full current JSON: all 95 results and environment](baselines/core-grouped-20261104.json).
- [Previous full JSON, unchanged provenance](baselines/pre-grouped-92baffb-20261104.json).
- [Generated tables including p95, V1 and bytes](CRDT-COMPARISON.md).
- [35 complementary codec/core/connector results](baselines/core-grouped-supplementary-20261104.json).

## Implementation boundary

Only one homogeneous, contiguous string/float64 field run in a single-version schema uses the new frame. Other writes use v1. Every value is checked before commitment; only application of provably overwritten scalar LWW writes is folded. The journal retains each exact row and supports arbitrary actor-prefix queries, legacy replay and forwarding. The actor history index replaces the redundant composite-key row Map; local writes still retain their actual native transaction without transport precomputation.

Unknown endpoints remain v1. Memory peers use the relay's actual capability; WebSocket requires explicit opt-in to a known upgraded endpoint and selection of `pulsify-v2`. The default WebSocket handshake offers no subprotocol. Storage expands opaque payload headers without a schema/document read; PostgreSQL remains one append call. Rust reconstructs exact legacy rows and keeps v1 output. See [wire format and capability contract](../docs/PROTOCOL.md#optional-grouped-transport-envelope-2-payload-2).

Independent review found and fixed negotiation with old Bun/non-subprotocol servers, missing individual export bounds, cross-document re-encoding, chunk fallback for large/mixed forwarded histories and expanded-budget growth. Defensive byte getters are read once in storage comparisons, and FoundationDB snapshots them once before transactional retries/chunking.

## Validation and reproduction

- `bun run check`: 320 passing package tests, two external database skips in the ordinary run, plus 14 passing adapter tests.
- Real database suite: 45 tests / 228 assertions on PostgreSQL, SQLite and FoundationDB, including large grouped strings and idempotence across FDB chunks.
- Rust: five unit tests and four interoperability tests, including grouped input, exact expansion and a real relay upload/reload.
- Independent reviewer tests and grouped integration tests: 14 tests / 370 assertions. All confirmed findings fixed and rechecked.
- Build and packed tarball: strict NodeNext declarations and Node execution pass. Built package passes Bun, Node, Deno and Chromium, including shared guarded run state across core/protocol entry points. Two-tab WebSocket/offline reconnection and sibling codec compatibility pass.

```sh
bun run check
bun run test:rust
bun run test:interop
bun run test:storage
bun run build
bun run test:package
bun run test:runtimes
bun run test:example
bun run bench:crdt --output benchmarks/results/grouped-repeat.json --markdown benchmarks/results/grouped-repeat.md
bun benchmarks/grouped-exchange-profile.ts --warm-suite
```

Do not run the diagnostic profiler concurrently with the comparison. The earlier prototype script accesses historical internals and must be reproduced on `92baffb` with its archived source snapshot.
