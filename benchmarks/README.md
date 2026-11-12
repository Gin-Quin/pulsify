# Performance benchmarks

The [full comparison](CRDT-COMPARISON.md) measures the current engine against
native json-joy, Yjs 13.6.33 (V2 and V1) and Loro 1.17.1 (Node WASM). It
contains all 95 measurements, payload sizes, scenario descriptions and
direct/public API comparisons. Its raw reference is
[core-compact-20261111.json](baselines/core-compact-20261111.json), measured
with the compact single-write frame (envelope 4). The
[hybrid transport note](HYBRID-TRANSPORT.md) describes the architecture and its
limits; its numbers are those of the previous campaign.
Competitor dependencies belong only to this private benchmark workspace.

The [native Rust database benchmark](database/README.md) exercises
concurrent full writes/reads, patch appends, lossless compaction, vector reads
and the 45/25/10/10/10 mix. Its [reference results](database/RESULTS.md)
compare PostgreSQL, SQLite, RocksDB, LevelDB and LMDB on one dedicated Linux
server, with 1, 4 and 8 cores. In Docker it also runs AlloyDB Omni, OrioleDB
and pgrust (row/columnar), with burst queues and contention measurements:

```sh
bun run bench:database --quick
bun run bench:database
```

```sh
bun run test:crdt
bun run bench:crdt --output benchmarks/results/crdt-new.json --markdown benchmarks/results/crdt-new.md
bun run bench:crdt --quick --output benchmarks/results/crdt-quick.json --markdown benchmarks/results/crdt-quick.md
bun run bench:compare benchmarks/baselines/core-compact-20261111.json benchmarks/results/crdt-new.json --strict
```

A quick or filtered run should always set `--markdown` to preserve the complete
committed report. The deliberate release-reference command is:

```sh
bun run bench:crdt --output benchmarks/baselines/core-compact-20261111.json --markdown benchmarks/CRDT-COMPARISON.md
```

## CRDT comparison method

The full suite uses five warmup samples and 25 measured samples. `--quick`
uses two plus eight. Each sample gets fresh replicas. Participants are shuffled
with a fixed seed. Fixtures, GC, reference-handle lookup, verification and
cleanup are outside timing. Created replicas remain alive until timing ends.
The report records runtime/library versions, CPU, architecture, platform,
parameters, timestamp, base commit and dirty-worktree status.

The data shape is the same in every engine: document metadata, an atomic
string, an editable nested map and a list of editable maps. Pulsify receives an
explicit codec schema and compiles its definition outside sample timing. The
new engine exploits that schema; it does not replace containers with opaque
JSON constants. The native json-joy graph builder is preserved separately in
[json-joy-builder.ts](json-joy-builder.ts).

The 18 primary scenarios cover creation with and without export, first and
repeated export, cached scalar reads, committed writes with three history
sizes, editable-object appends, edit plus encoding, incremental round trips,
initial load plus a detached snapshot, offline merge and a 16-peer map conflict.
Separate cases compare native json-joy, the direct Pulsify setter and the public
Pulsify proxy. Both Pulsify setters use the same guarded commit/journal path;
an adapter test checks identical document states and encoded rows.

Times are **medians and p95 values of per-sample average operation times**.
They are not individual-event tail-latency measurements. Small differences,
especially nanosecond-scale ones, can reflect JIT or scheduling noise. An
aggregate speedup uses the unweighted geometric mean of `competitor median /
Pulsify median`, with each of the 18 cases receiving equal weight. It does not
establish a universal engine ranking or statistical significance.

Local creation and writes retain native operations without binary encoding.
Cases whose name includes encoding or export add that work explicitly. Initial
load includes a new receiver and detached JSON snapshot; source export and
cleanup are outside timing. First and repeated export use fresh prepared
documents; repeat performs one preparatory export outside timing. Incremental
round trips include vector capture, edit, encoding, peer import and a peer read,
without network transport, acknowledgement or durable storage.

The engines retain different histories. Pulsify transfers immutable operation
rows with document IDs and causal vectors. Between two pulses, a lone scalar
write travels as a compact frame that the receiver expands into the same row;
connector sessions, relays and stores keep exact rows. Json-joy exports structural snapshots
and deltas, which can condense overwritten registers. Yjs uses its default GC;
Loro uses snapshots with history and updates. Keep these differences and payload
sizes next to offline-merge results. The Loro library is Node WASM, initialized
before measurement; neither process startup nor WASM compilation is timed.
JavaScript heap alone cannot rank total memory against WASM.

The suite does not time rich-text editing, schema migrations, materializers,
constants, database ingestion or database queries. Those features have separate
correctness/integration checks. Historical PostgreSQL measurements are in
[STORAGE-BENCHMARKS.md](../docs/STORAGE-BENCHMARKS.md). The separate
[database suite](database/README.md) compares storage engines under one storage
policy; its [results](database/RESULTS.md) come from a dedicated server.

## Supplementary protocol and connector suite

```sh
bun run bench
bun run bench --quick
bun run bench --filter operations --output benchmarks/results/operations.json
bun run bench --output benchmarks/results/core-new.json
```

The supplementary suite measures outer frame codecs, operation codecs,
creation/mutation, connector synchronization, initial loading, offline reconnect
and diagnostic retained heap. It uses the legacy typed-definition API without
an application runtime schema; the primary CRDT comparison above supplies the
schema required for the optimized native path.

Outer decoding leaves operation bytes opaque. Inner codec cases encode and
decode native `CoreOperation` values separately. Application value checks and
CRDT graph/reference validation are part of the engine's mutation/import path,
not an extra recursive walk of the envelope schema.

Connector cases wait for acknowledgement and convergence, including a variant
with a 5 ms delay in each direction. Initial loading confirms public data
availability. Heap observations use GC before/after a prepared history or a
create/destroy loop; they are diagnostic rather than RSS measurements or proof
of leak absence.

## Previous-engine records

[core-start-20261104.json](baselines/core-start-20261104.json) is the clean
`fab84ad` snapshot captured immediately before this rewrite. Its
[baseline note](CORE-BASELINE.md) records the original 95-case results. Comparing
it with the native core describes an intentional engine/schema change; strict
same-implementation regression checks correctly refuse the changed parameters.

Other saved baselines and the following reports describe the **previous
json-joy-backed implementation**. Their historical timings, heap numbers and
statements about removed validators or portable verbose operations are not
measurements or implementation claims about the current native engine:

- [Previous CRDT baseline](baselines/crdt-comparison.json).
- [Previous supplementary baseline](baselines/local-bun.json).
- [Schema validation removal](SCHEMA-VALIDATION-REMOVAL.md).
- [Runtime simplification](RUNTIME-SIMPLIFICATION.md).
- [Deferred encoding and its memory tradeoff](LAZY-ENCODING.md).
- [Independent fairness audit and subsequent recheck](INDEPENDENT-AUDIT.md).

The native engine compiles and executes affected application-value checks,
retains immutable causal rows and defers binary encoding. Historical removal
of an additional generic validator does not mean the new engine skips value,
metadata or causal-reference checks.

## Regression comparisons

`--strict` exits unsuccessfully on a detected regression; the default mode is
advisory. Reports must match runtime/library versions, CPU, architecture,
platform, parameters, schema and iteration counts. Recreate a reference on the
measurement machine instead of comparing unrelated developer and CI runners.

The provisional thresholds are median time +20% with an absolute noise
allowance, encoded size +5%, and retained-history heap +25% plus 64 KiB.
Sub-microsecond cases receive a 0.1 µs allowance, other ordinary cases 0.5 µs,
creation 5 µs and synchronization 100 µs. Lifecycle heap deltas are recorded
without a blocking threshold because GC/JIT effects make one delta noisy.

CI runs quick suites and uploads artifacts; it checks execution, not timing
on a shared runner. Use complete repeated runs on a stable machine for release
decisions. A normal report does not overwrite a saved baseline unless its exact
path is supplied to `--output`.
