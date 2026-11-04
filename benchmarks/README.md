# Performance benchmarks

The [CRDT comparison](CRDT-COMPARISON.md) measures Pulsify, native json-joy, Yjs 13.6.33 (V2 and V1) and Loro 1.17.1 (Node WASM). Its 95 results include a three-layer comparison of native json-joy, the Pulsify mutation pipeline bypassing proxies, and the public proxy, plus separate first and repeated exports. The report documents the upstream GitHub scenarios used, convergence checks, payload sizes, and differences in retained history. These dependencies belong only to the private benchmark workspace.

```sh
bun run test:crdt
bun run bench:crdt                             # Full JSON + generated CRDT-COMPARISON.md
bun run bench:crdt --quick --output benchmarks/results/crdt-quick.json --markdown benchmarks/results/crdt-quick.md
bun run bench:crdt --output benchmarks/results/crdt-new.json
bun run bench:compare benchmarks/baselines/crdt-comparison.json benchmarks/results/crdt-new.json --strict
```

The committed comparison was generated with `bun run bench:crdt --output benchmarks/baselines/crdt-comparison.json`. A quick or filtered run should use `--markdown` to keep the full Markdown reference. Timing comparisons require matching parameters and environment, including the Yjs/Loro versions and backend. The new suite measures synchronous engine exchange; the 35-case suite below also covers Pulsify's connectors and acknowledgements.

```sh
bun run bench                                  # Full report; JSON on stdout and results/latest.json
bun run bench --quick                          # Short CI smoke run
bun run bench --filter operations              # Filter cases by substring
bun run bench --output benchmarks/results/new.json
bun run bench:compare benchmarks/baselines/local-bun.json benchmarks/results/new.json
bun run bench:compare benchmarks/baselines/local-bun.json benchmarks/results/new.json --strict
```

`--strict` exits unsuccessfully on a detected regression. The default comparison is advisory. Reports with different runtime/library versions, CPU, architecture, platform, parameters or report schema are refused. Recreate a baseline on the measurement machine rather than comparing an ordinary CI runner to a developer laptop. The saved [local reference](baselines/local-bun.json) includes the base commit, dirty-worktree flag, timestamp and environment.

## Method

The full suite uses five warmup samples followed by 25 measured samples; `--quick` uses two plus eight. Fixtures and session IDs are deterministic. Each sample gets fresh state and cleanup outside the timed interval. Repeated operation counts are recorded per case. No forced garbage collection occurs inside timed loops.

The latency values are the median and p95 of **per-sample average operation times**, not a per-event tail-latency guarantee. The harness records min/max, derived operations/second and encoded byte counts too. The cold-schema compilation case is separate from reused, compiled codec throughput. Process startup and package import are exercised by the runtime smoke matrix, not included in serializer numbers.

The suite covers:

- Outer message encoding/decoding and JSON with binary payloads represented as base64. A case suffix `100` means a document fixture with 100 items, not 100 messages. Outer decoding leaves operation bytes opaque.
- Inner operation encoding/decoding separately, including portable constant conversion. Codec handles the schema directly, without a separate validation traversal or byte preflight. Operation decoding includes deserialization into the verbose operation representation; CRDT patch construction/application occurs in synchronization cases.
- Local creation and mutation compared with bare `json-joy`, exposing the cost of the API and native patch journal. Neither participant performs portable conversion or binary encoding in these cases. Fixtures and cleanup are outside the creation timing, and created objects remain alive until timing ends for both participants. The CRDT suite separately measures creation with binary export.
- Mutations with 0, 1,000 and 5,000 prior segments, to detect history-dependent costs. Both participants cache the nested container outside timing and use the same number of operations; the native no-history case is the reference, not a claim of equal retained history. `core/read-nested` separately measures the full public lookup path.
- End-to-end in-memory synchronization, initial loading and reconnection after 100 offline edits. An additional case inserts 5 ms in each transport direction. Timed operations wait for peer acknowledgement and receiver convergence; frame/byte counters cover the measured sample, excluding initial setup. Initial loading includes a public array-length read to confirm data availability; all receiver destruction happens after timing.
- Retained heap after a 5,000-edit history, and heap delta across 1,000 create/destroy cycles, with GC before/after. Heap numbers are diagnostic; lifecycle correctness is also tested through released identity maps, listeners and sessions.

The JSON comparison uses the same message or operation values. Cases named `codec/*` measure Pulsify's message wrappers, including protocol-specific checks and framing, rather than the raw serializer alone. JSON variants serialize/parse these fixtures without Pulsify's protocol consistency checks, so they do not have identical validation guarantees. The published codec package's standalone serializer benchmarks are a different workload.

## Local reference

Measured with Bun 1.4.4, codec 2.1.0, json-joy 18.28.0, Apple M4 / arm64 / macOS. The report contains 35 cases, measured at 2026-11-04T01:22:33.603Z. Values below are local observations, not performance guarantees across machines. This audit follow-up run was collected on a busy shared machine; timing ratios and regression decisions require a quiet rerun. See the audit for the recorded load and noise caveat.

| Case | Median µs/op | p95 of sample means, µs/op | Operations/s | Encoded bytes |
| --- | ---: | ---: | ---: | ---: |
| `protocol/compile-schema` | 54.58 | 136.64 | 18,321 | — |
| `codec/encode/0` | 0.14 | 0.25 | 7,187,781 | 15 |
| `codec/decode/0` | 0.13 | 1.60 | 7,799,825 | 15 |
| `json/encode/0` | 0.59 | 2.53 | 1,691,332 | 52 |
| `json/decode/0` | 0.96 | 4.08 | 1,036,672 | 52 |
| `codec/encode/1` | 0.42 | 3.52 | 2,405,292 | 429 |
| `codec/decode/1` | 0.40 | 1.25 | 2,503,912 | 429 |
| `json/encode/1` | 2.13 | 3.27 | 470,118 | 694 |
| `json/decode/1` | 2.61 | 4.69 | 382,995 | 694 |
| `operations/encode/1` | 3.79 | 6.62 | 263,992 | 391 |
| `operations/decode/1` | 7.35 | 77.80 | 135,991 | 391 |
| `operations-json/encode/1` | 8.15 | 18.97 | 122,660 | 783 |
| `operations-json/decode/1` | 19.05 | 223.66 | 52,501 | 783 |
| `codec/encode/100` | 1.61 | 5.64 | 619,915 | 9319 |
| `codec/decode/100` | 0.73 | 1.52 | 1,364,024 | 9319 |
| `json/encode/100` | 12.89 | 18.18 | 77,572 | 12544 |
| `json/decode/100` | 6.08 | 11.30 | 164,587 | 12544 |
| `operations/encode/100` | 67.92 | 104.91 | 14,724 | 9279 |
| `operations/decode/100` | 133.04 | 167.13 | 7,517 | 9279 |
| `operations-json/encode/100` | 167.65 | 257.59 | 5,965 | 18599 |
| `operations-json/decode/100` | 487.64 | 820.61 | 2,051 | 18599 |
| `core/create/10` | 18.42 | 533.29 | 54,293 | — |
| `json-joy/create/10` | 17.60 | 291.95 | 56,825 | — |
| `core/create/1000` | 716.65 | 2216.37 | 1,395 | — |
| `json-joy/create/1000` | 1113.98 | 2824.79 | 898 | — |
| `core/read-nested` | 0.45 | 1.40 | 2,203,391 | — |
| `core/mutate/history-0` | 4.05 | 9.39 | 246,875 | — |
| `core/mutate/history-1000` | 2.13 | 5.17 | 470,496 | — |
| `core/mutate/history-5000` | 2.79 | 11.13 | 357,916 | — |
| `json-joy/mutate` | 0.25 | 0.42 | 3,928,038 | — |
| `sync/update/one-way-0ms` | 38.44 | 120.35 | 26,016 | — |
| `sync/update/one-way-5ms` | 12711.79 | 14540.31 | 79 | — |
| `sync/initial-load/10` | 39.66 | 50.67 | 25,215 | — |
| `sync/initial-load/1000` | 2767.19 | 4356.71 | 361 | — |
| `sync/reconnect/100-offline-edits` | 622.21 | 2454.88 | 1,607 | — |

The 100-item operation payload uses 9279 binary bytes versus 18599 JSON UTF-8 bytes. Outer message numbers and operation numbers must not be added or compared as if they measured the same layer. At this workload, binary operation encoding and decoding are faster than the corresponding JSON operations, and the binary representation is smaller. Local creation and edits retain native patches; their serialization cost is measured only when explicitly exported. The journal and public API overhead remain visible against bare json-joy.


### Retained memory

| Measurement | Result |
| --- | ---: |
| Retained native history rows, before export | 5,001 |
| Heap increase for native history, before export | 5,171,170 bytes (4.93 MiB) |
| Heap delta after 1,000 create/destroy cycles | 40,534 bytes (39.6 KiB) |

These are post-GC heap observations, not process RSS or proof of a leak. The lifecycle tests separately verify release of identity entries, subscriptions and sessions.

The journal uses a per-actor sorted index with binary searches for overlap checks and missing ranges. An early implementation scanned the whole history on every append; the history-scaling cases were added to catch that regression.

## Removal of the extra schema validation

The recursive schema validator and binary preflight were removed from Pulsify. See the [before/after measurements](SCHEMA-VALIDATION-REMOVAL.md); the previous JSON references are retained alongside the updated baselines. Codec now handles the schema directly.

## Runtime simplification

The receive path now applies each patch once, checks only metadata and changed links, and does not clone or traverse the document. Migrations copy values only when they actually run. Plain snapshots copy the engine view directly. See the [before/after measurements](RUNTIME-SIMPLIFICATION.md).

## Deferred encoding and local creation

Local creation and edits no longer convert patches to the portable format or encode bytes. First send/export materializes the requested rows; later exports reuse their cached bytes. The root proxy and identity registry remain. Creation fixtures and destruction are now outside timing for both core participants; the `creationTiming` parameter prevents comparisons with the older core harness. See the [measured before/after and memory tradeoff](LAZY-ENCODING.md).

## Independent fairness audit

An independent agent ran both full suites and checked data shapes, transaction boundaries, setup/cleanup, object lifetimes, serialization, history retention and WASM handles. Its two supplementary-suite findings are corrected: cached nested references and iteration counts now match, and initial-load destruction is outside timing. The new `mutationTiming` and `initialLoadTiming` parameters prevent comparison with the older core measurement protocol. See the [original audit and independent recheck](INDEPENDENT-AUDIT.md).

The CRDT suite additionally separates `export-first/1000` from `export-repeat/1000`. Both export a fresh prepared document once per sample; the repeated case performs one preparatory export outside timing. Every measured payload is imported and checked outside timing. These are warm-library measurements of per-document cache state, not process startup benchmarks.

Comparisons must keep editable containers and atomic strings equivalent, use the same commit boundaries and number of operations, resolve equivalent handles outside timing, and put fixture preparation and cleanup outside timing. Keep created replicas alive until timing ends. Label first versus repeated export explicitly. Product task comparisons may use each engine's own format and history policy; they do not isolate codec or Proxy instruction costs. The public-versus-direct Pulsify delta includes setter guards and conversions as well as Proxy traps.

## Regression policy

Initial thresholds are provisional and should be calibrated on a stable runner:

- Median time: +20%, plus a noise allowance of 0.1 µs for sub-microsecond cases, 0.5 µs otherwise, 5 µs for document creation, or 100 µs for synchronization.
- Encoded size: +5%.
- Retained history heap: +25% plus 64 KiB. Lifecycle heap deltas are recorded without a blocking threshold because GC timing and JIT caches make a single delta noisy.

CI runs both quick suites and uploads their JSON artifacts plus the CRDT Markdown report. It verifies benchmark execution but does not gate timing on shared runners. Use full repeated runs and `--strict` on the same stable machine for a release decision. Baselines are updated deliberately after reviewing regressions; generating a new report does not overwrite the saved JSON baseline unless that exact output path is supplied.
