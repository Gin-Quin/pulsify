# Compiled value preparation and remote preflight

Typed local container writes now use `PulseLayout.prepare` to validate, detach
and normalize the input in one compiled traversal. Initial document creation
uses the same parser through `CoreModel.prepareRootInput`. Scalar commits retain
their existing fast path. Migration normalization also uses preparation, retaining
explicit constant/text paths and rejecting paths removed by normalization.

Preparation preserves the portable value grammar, schema field order, float32
normalization and the explicit wrapper markers. Schema annotations remain layout
flags. Extra input properties are validated before they are omitted. The depth
limit applies to the normalized result, including synthesized optional values,
and preparation of a nested subtree includes its supplied initial depth.

Remote preflight validates each schema node while constructing the staged CRDT
nodes. `assertShallow` checks the current value before layout resolution; walking
the value checks required fields, sequence density, dynamic keys and depth.
Constant subtrees use full preparation before freezing. Unknown subtrees use the
portable parser with their enclosing depth. Character entries synthesized for
rich text do not add a level to the input value's depth.

All construction remains staged until the complete batch passes preflight.
Markers are checked again against the normalized result, so a marker referring
to an omitted extra field cannot be retained. Reusing a decoded object requires
the exact canonical key sequence. Noncanonical objects are rebuilt, and every
omitted extra key and value is validated before being dropped.

The four managed metadata fields remain outside root map/literal application
layouts. An object schema can also declare those fields explicitly; their types
are checked, and root traversal deduplicates their keys. Framework fields remain
plain metadata during generic application and migrations. Node ID order and the
immutable per-transaction history are preserved.

Notification dispatch now snapshots both listener sets before invoking callbacks.
A subscription can replace itself during a callback without adding repeated
callbacks to the current dispatch.

Detached document snapshots have a separate generated copy path. Each object
checks its stored key sequence before using the schema-shaped copy. A divergent
subtree uses a general detached copy, preserving deleted optional properties,
retired migration fields and property order. Snapshot copies do not normalize
stored values again. Binary copies always allocate a base `Uint8Array`, including
when the input is a Node `Buffer` whose `slice()` would share memory.

## Warm A/B diagnostics

The following measurements were taken on 2026-11-04 in one Bun process using
30 measured pairs after 10 warmup pairs. Pair order alternates. The reference
uses the preceding implementations of `set`, `splice`, `normalize`, `validate`,
`build` and initial preparation; the new variant uses compiled preparation and
fused preflight. Both variants use the same schema compiler, journal, transport
and snapshot implementation. Fixtures, seed export and cleanup are outside
timing. These diagnostics do not replace the complete cross-library comparison.

| Case | Previous, µs/op | New, µs/op | New / previous |
| --- | ---: | ---: | ---: |
| Create, 10 items | 9.492 | 6.023 | 0.635 |
| Create, 1,000 items | 371.64 | 253.22 | 0.681 |
| Initial load and materialization, 10 items | 9.613 | 10.379 | 1.080 |
| Initial load and materialization, 1,000 items | 300.13 | 285.56 | 0.951 |
| Append, 10 initial items | 0.9583 | 0.8292 | 0.865 |
| Append, 1,000 initial items | 0.9213 | 0.8296 | 0.900 |

Create/load diagnostics use 20 operations per sample for 10-item documents and
three operations for 1,000-item documents. Append diagnostics use 100 committed
appends per fresh document; the 1,000-item append case is supplementary.

Independent regression coverage is in `schema-prepare-equivalence.test.ts` and
`compiled-remote-validation.test.ts`. `core-prepared-model.test.ts` covers partial
and complete metadata schemas, nested ID stability, bidirectional synchronization,
fresh replay, invalid metadata types and reentrant subscription replacement.

```sh
bun test packages/pulse/tests
bun run typecheck
bun run test:crdt
bun run bench:crdt --output benchmarks/results/core-final.json --markdown benchmarks/results/core-final.md
```
