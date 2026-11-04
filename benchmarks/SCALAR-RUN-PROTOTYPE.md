> Historical prototype against `92baffb`. The grouped transport is now integrated
> through the public API; see [the production integration](GROUPED-TRANSPORT.md).
> This diagnostic accesses the old journal internals: reproduce it on `92baffb`,
> using its exact source snapshot and dependencies, rather than on the new journal.

# Exact scalar history blocks: experimental work

This is an isolated experiment following the [stable pipeline improvement](OFFLINE-MERGE.md),
not a released protocol or an alternative primary benchmark. Production remains
on envelope v1 / payload v2 at source commit `92baffb`. The experiment does not
establish production parity with json-joy.

[`scalar-run-prototype.ts`](scalar-run-prototype.ts) prepares the unchanged
editable fixture, initial shared snapshot and 100 real native commits per peer.
Timing includes vector capture, two complete exports, two imports and two detached
snapshots. No grouping, encoding or remote validation is prepared outside timing.
There are 201 retained rows after merge: the shared initial transaction and all
200 edits. Cleanup, verification and GC follow the ordinary harness boundaries.

## Representation and exact expansion

One experimental frame contains the document/request/vector header and one run:

```text
sid, clockStart, count, lamportStart, schema, target, field, layout, externalVV
payload_0, payload_1, ..., payload_(count-1)  // each length prefixed
```

The prototype uses an experimental envelope tag 2. Existing production endpoints
reject it. It supports string/float64 scalar columns only, without migrations,
managed fields, constant or rich-text captures. Every row has span 1, the same
actor/schema/target/field/layout, consecutive clocks and Lamport values, and an
identical external dependency vector. Its own dependency is absent at clock 1;
otherwise it is exactly `(sid, clock_i)`. The exporter checks these facts for
every original row inside timing.

For offset `i`, the original canonical operation payload is exactly:

```text
payloadVersion=2, lamportStart+i, schema, opCount=1, opKind=1,
target, fieldTag, field, layout, lengthPrefixed(payload_i),
constantPathCount=0, richTextPathCount=0
```

This is lossless header grouping, not keeping only the last transaction. The
actual native `PatchLog` retains all row identities and frontiers. Imported rows
refer to owned frame bytes, with bounded value offsets and lazy legacy operation
bytes/dependency tuples. Those legacy representations are expanded when a legacy
reader actually requests them; the new transport already contains their entire
information. No value or transaction is absent from the timed packet/import.

## Validation and application

The experiment compares five paths against unchanged native json-joy:

1. Current production Pulsify.
2. Grouped bytes with every normal `CoreModel.validate` and `apply` call.
3. Grouped bytes with normal preflight and final winning scalar application.
4. The same with a diagnostic cursor running actual `validateSingle` on every
   value, avoiding 100 temporary patch wrappers.
5. A strict scalar-run guard, compiled assertion on every value, and final winning
   scalar application. It uses the frame's DataView and retained offsets rather
   than allocating a Decoder and byte view per value.

The last guard checks schema, target, field, annotations and source-node causal
coverage once. External dependencies are fixed and own clocks increase; coverage
of the first source-node reference proves coverage for all later references.
Every value still receives its compiled schema assertion. Header/range checks
prove all individual clocks, spans and dependency vectors before commitment.
The receive path checks ordinary history row/byte limits, frame/value limits,
actor-vector limits and an expanded schema-node budget before allocating rows.
It charges expanded history sizes; requesting legacy bytes later does not charge
them twice. No model or journal changes occur before preflight completes.

Applying only the last incoming scalar preserves the total LWW ordering: all
incoming stamps increase strictly, so earlier ones cannot beat an existing stamp
when the last one cannot. The original model's winning-stamp test still runs.
No operation in the run creates a CRDT node/reference, changes schemas or changes
the notification boundary. All intermediate writes remain independently
replayable from the retained journal. Lamport and actor-clock maxima are the same.
Loaded-state, closed-state checks, status and listener error handling are kept.

Selfchecks compare every actor-prefix frontier (203 cases), exact expanded bytes
between both peers, a fresh legacy replay, future local causal dependencies,
Buffer ownership and unchanged accounting after materializing retained rows.
They reject an invalid *first* value even when 99 valid overwrites follow it,
truncation, trailing bytes, invalid run counts, excessive expanded bytes and an
expanded schema-node bomb atomically. The run guard is compared against normal
preflight on 72 context/value combinations, including malformed Unicode, NaN,
Infinity, wrong scalar types, unknown targets/fields/schemas and uncovered causal
references. A newer existing register stamp and listener failures are exercised.

## Measurement method

```sh
bun run typecheck
bun benchmarks/scalar-run-prototype.ts benchmarks/results/scalar-run.json --warm-suite
bun benchmarks/scalar-run-prototype.ts benchmarks/results/scalar-run-profile.json --warm-suite --profile
```

`--warm-suite` first runs **the unchanged complete 95-case official suite in the
same process**. Its entire report is embedded in the experimental JSON. It then
uses five warmup and 25 measured samples with seeded shuffled participants and
fresh peers. This matters: json-joy in a cold filtered process can exceed 120 µs,
while the same task after the complete suite is about 80 µs. Comparing the
prototype only against the cold number would overstate the result.

The timed loop contains no `isDeepStrictEqual`; numeric dependency comparisons
retain the actual homogeneity checks. Deep comparisons and exhaustive history
checks happen only after timing. Optional bulk phase timers are diagnostic and
must not replace the uninstrumented comparison.

## Warm measurements before removing the duplicate index

Three independent warm processes used the same earlier source SHA-256
`1cc5cbfdcd3d9d730d95ad1260682dbff8028af2e4260a4854340b74bbbeb534`.
The machine is the same Apple M4 / arm64 / Bun 1.4.4 as the stable comparison.
Each report includes its runtime, source hash, all 25 experimental samples and
the complete unchanged suite that preceded them. Times are µs per exchange.

| Process | Production Pulsify control | Best experimental run guard | json-joy control | Prototype / json-joy |
| --- | ---: | ---: | ---: | ---: |
| 1 | 268.833 | 80.042 | 78.958 | 1.014× |
| 2 | 277.375 | 78.792 | 76.375 | 1.032× |
| 3 | 282.583 | 82.166 | 80.959 | 1.015× |

The grouped transport consistently contains **2,246 bytes** rather than 17,334;
json-joy still contains 139. The experimental path is much faster than its
production control, but remains 1.4–3.2% slower than the warm json-joy control in
all three final processes. Earlier individual runs reversed this small margin.
That candidate did not establish warm parity. P95 ordering also varied; no
tail-latency advantage was claimed.

- [Warm process 1](baselines/scalar-run-prototype-20261104/warm-1.json)
- [Warm process 2](baselines/scalar-run-prototype-20261104/warm-2.json)
- [Warm process 3](baselines/scalar-run-prototype-20261104/warm-3.json)
- [Separate instrumented warm phases](baselines/scalar-run-prototype-20261104/profile.json)

The remaining work includes the native history representation itself: eligibility
and metadata processing still inspect 100 local rows per direction, and reception
still creates 100 journal entries. Maintaining an additional group index during the
100 untimed writes would merely relocate work unless the actual native journal
representation also improves creation/mutation; such a change needs measurements
of those write paths as well as the exchange. The experiment deliberately does
not make that trade or hide that cost.

## Warm proof with one journal index

The original journal stores every immutable row both in a composite-key Map and
in sorted actor histories. A final experimental variant keeps the actor histories
and an exact row counter, using binary lookup for existing identities and an O(1)
test after the actor's last clock. Appending the validated contiguous run therefore
does not build a second Map or 100 composite keys. All row objects and identities
still exist. This is not a last-value history representation.

Three further independent processes used the same final script SHA-256
`4c995bf2b43484ec159bdf19ab7dc9c0906d309ee34ed8fc09e161652872c021`.
Each first ran the unchanged complete official suite. The table includes both
grouped variants from the **same process**, with all 25 samples retained.

| Process | Grouped, duplicate index | Grouped, actor index only | json-joy | Median decrease vs json-joy |
| --- | ---: | ---: | ---: | ---: |
| 1 | 79.333 | 71.208 | 85.750 | 17.0% |
| 2 | 77.666 | 68.666 | 82.875 | 17.1% |
| 3 | 79.250 | 69.958 | 82.458 | 15.2% |

The prototype now has a consistent warm median advantage on this machine, while
retaining the same 2,246-byte exact-history transfer. **This is a prototype proof,
not a production parity result.** The real protocol, normal public export path,
negotiation, Rust and persistence integration remain unimplemented. The standalone
index change did not establish a reliable gain with the existing row-by-row
transport, so no production index change was retained in this stage.

The normal legacy receive path is also exercised after installing the experimental
index: duplicate rows remain harmless and changed bytes for an existing identity
still reject. The source's direct journal access is deliberately limited to this
diagnostic; it is not a supported Map replacement or a product API.

- [Final warm process 1](baselines/scalar-run-prototype-20261104/index-warm-1.json)
- [Final warm process 2](baselines/scalar-run-prototype-20261104/index-warm-2.json)
- [Final warm process 3](baselines/scalar-run-prototype-20261104/index-warm-3.json)
- [Separate final phase diagnosis](baselines/scalar-run-prototype-20261104/index-profile.json)
- [Exact final diagnostic source snapshot](baselines/scalar-run-prototype-20261104/source-actor-index.ts.txt)

The checked-in prototype matches that source snapshot and currently runs against
the unchanged production journal at `92baffb`. To reproduce after a future journal
rewrite, use that source revision and copy the source snapshot back to
`benchmarks/scalar-run-prototype.ts`, with the documented benchmark dependencies.

## What remains before a product implementation

The prototype's contiguous, new-delivery path is explicit. Duplicates, overlaps
and gaps reject without changing state; production would need an exact canonical
fallback to the existing journal, including pending rows and fork handling.
The prototype accesses private journal state and does not provide a public export
API, negotiated capabilities, grouped relay forwarding or persistence ingress.
Its legacy public exports/replay are exact; generic compact re-export of arbitrary
received noncanonical value bytes is not yet established.

A production design would need all of the following, before enabling the path:

- An explicitly negotiated envelope extension, with unchanged v1 fixtures and
  v1 default behavior for peers whose capabilities are unknown. A transport
  capability or a negotiated WebSocket subprotocol must reflect the actual
  endpoint. A benchmark adapter cannot silently assume an old peer supports it.
- One normal public export path shared with Connection and the server. Latest
  in-process replicas may advertise actual supported capabilities; the adapter
  must call that public path, rather than manufacturing grouped packets.
- Mixed opaque legacy rows and exact scalar runs. Unsupported application shapes
  and noncanonical rows need the existing path, including managed fields,
  migrations, constants, rich text and editable container replacements.
- Exact sub-run clipping for all partial vectors, arbitrary forwarding and
  retransmissions. Raw value payloads must remain byte-exact rather than being
  decoded and re-encoded during forwarding. Every duplicate/fork/overlap path
  must compare the same immutable logical rows as v1.
- A schema-independent decoder in Rust and in `appendEncoded`. Storage can
  expand runs into ordinary immutable rows without building a document, but
  that expansion has a real CPU/allocation cost at database ingress. It must be
  measured and documented, not hidden in the core CPU comparison.
- Differential runtime/convergence tests, v1/v2 cross-peer tests, malformed and
  quota tests, real storage and Rust interoperability checks, all runtime checks,
  and a final complete campaign before any production parity claim.

The experiment narrows the remaining cost, but compatibility and integration are
substantial work. The final combined experiment provides a reason to design that
integration; it does not remove its correctness or full-campaign requirements.
