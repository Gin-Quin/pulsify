# Native scalar commits

The native core retains one immutable journal row for each committed transaction.
Scalar writes now retain a `ScalarPatch` directly instead of constructing a
`PreparedValue`, operation object and operation array before that row is exported.
The patch constructs and caches its normal `kind: 1` operation body on its first
export. Its actor, clock, Lamport time, schema, target, field and scalar value are
captured at commit time; later writes cannot change a retained patch.

`CoreModel.set` uses this path only for a single-version document and primitive
values without constant or rich-text annotations. It still checks attachment,
managed fields, constant fields, supported keys, finite numbers, valid Unicode
and the field schema. Negative zero is canonicalized before the schema clone,
and schema normalization such as float32 rounding happens before retention.
Object values, arrays, rich text, constants and versioned migrations keep their
general operation path.

With no pending causal rows, the runtime appends the native patch before updating
the local register, its stamp and the model clocks. Journal limits and clock
exhaustion therefore reject the write before any document state changes. The new
local Lamport time exceeds every applied stamp, so the write uses the same LWW
winner as the general application path. It detaches a replaced child and uses the
same loaded-state and synchronous notification behavior.

When the journal contains pending rows, scalar writes use the existing general
commit and preflight path. A local write can still release dependent remote rows;
the complete newly available batch is validated before its frontier advances.

No transaction boundaries, wire versions or bytes changed. This preserves exact
duplicate detection and queries from arbitrary version vectors, including every
intermediate scalar write. Single register patches also have a codec fast path
that writes the existing schema representation directly. Other operation shapes
keep the schema-compiled codec.

## Diagnostic measurements

These are warm, same-process A/B diagnostics from 2026-11-04, not the final
cross-library comparison. Each of 40 measured pairs follows 20 warmup pairs and
times 2,000 scalar writes on fresh state. Pair order alternates. The reference
uses the preceding `CoreModel.set` implementation: preparation, schema
normalization, ordinary `CorePatch` retention and `CoreModel.apply`. Both variants
use the same current journal and schema implementation. Setup, cached nested
handle resolution and cleanup are outside timing.

| Path | Existing history | General commit, µs/write | Scalar commit, µs/write |
| --- | ---: | ---: | ---: |
| Public proxy | 0 | 0.1641 | 0.1380 |
| Public proxy | 5,000 | 0.1524 | 0.1359 |
| Direct native setter | 0 | 0.1551 | 0.1201 |
| Direct native setter | 5,000 | 0.1453 | 0.1148 |

Independent warm A/B diagnostics measured a 16-peer merge at 62.92 → 40.12 µs
after adding the contiguous single-row journal receive path. The 100-edit
offline merge measured 494.29 → 400.96 µs after adding the ascending single-actor
batch receive path. These journal paths avoid staging maps and a causal work
queue when the incoming history is already contiguous and available. Gaps,
mixed actors, reverse order and existing pending rows use the general algorithm.
Validation, input ownership and atomic preflight remain in both paths.

Use the complete comparison for final cross-library conclusions:

```sh
bun test packages/pulse/tests
bun run typecheck
bun run test:crdt
bun run bench:crdt --output benchmarks/results/core-final.json --markdown benchmarks/results/core-final.md
```

The regression tests cover lazy body construction, byte equality with general
commits after long histories, stable historical rows, replay into fresh replicas,
scope reuse, destruction, notifications, stale child references, clock and row
limits, pending-row release, and differential journal behavior for forks, gaps,
overlaps and duplicates.
