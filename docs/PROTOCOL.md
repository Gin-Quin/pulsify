# Pulsify binary protocol

Default envelope version **1**, optional grouped envelope **2**, state envelope **3**
and compact write envelope **4**.
All envelopes and core payloads use operations version **3**. Earlier operation
versions are unsupported.
The native core has no
runtime dependency on json-joy or Yjs. The TypeScript implementation uses
`@gin-quin/codec` 2.1.0. The [Rust crate](../crates/pulsify-protocol) implements
the envelope independently and keeps operation bytes opaque.
[Shared byte fixtures](../fixtures/protocol.json) are the compatibility
authority. Regenerate them only for an intentional wire change with
`bun scripts/generate-fixtures.ts`.

Operation format 1 from the previous json-joy implementation is not accepted.
Changing a stored document's migration `version` does not translate an older
wire format into the new operation format.

## Scalar encoding and framing

- `uint`: unsigned base-128 varint; seven payload bits per byte and a high
  continuation bit. Envelope integers must be safe JavaScript integers in
  `[0, 2^53 - 1]`, subject to the positive-clock rules below.
- `string`: `uint` UTF-8 byte length followed by the bytes. Document IDs are
  opaque strings and need not be UUIDs.
- `boolean`: one byte, 0 or 1.
- `bytes`: `uint` byte length followed by the payload.
- Arrays: `uint` element count followed by the elements. Tuples have no count.
- Objects: fields in the exact schema order, without property names or padding.

A WebSocket message contains one complete frame. Stream transports supply
framing themselves, for example an external length prefix. Arbitrary
concatenation is rejected as trailing data. Encoders emit the valid scalar
representations above; malformed scalar acceptance otherwise follows codec's
reader behavior. The independent Rust decoder additionally enforces strict
scalar checks and its collection limits.

```text
protocolVersion:uint = 1
operationsVersion:uint = 3
kind:uint
...variant fields
```

Every variant starts with `docId:string, requestId:uint`, in that order.

| Kind | Name | Remaining fields, in wire order |
| --- | --- | --- |
| 1 | connect | vv:vector |
| 2 | sync | found:boolean, complete:boolean, vv:vector, rows:row[] |
| 3 | syncBack | vv:vector, rows:row[] |
| 4 | update | vv:vector, rows:row[] |
| 5 | ack | vv:vector |
| 6 | error | code:string, message:string |

A session serves one document. `requestId` correlates a request and response;
server pushes use update with request ID zero. A connect request can receive
several sync pages with the same ID. Only the last has `complete = true`.
Reference relays acknowledge accepted history in memory. A relay using durable
storage must commit the database transaction before sending its ack.

Error codes include `INVALID_MESSAGE`, `UNSUPPORTED_VERSION`, `NOT_FOUND`,
`INCOMPATIBLE_DOCUMENT`, `CLOSED`, `TIMEOUT`, `CONNECTION_FAILED`, `CONFLICT`,
`LIMIT_EXCEEDED`, `HISTORY_UNAVAILABLE` and `FORBIDDEN`. A server may pin a
session to one document before its connect frame and may open it read-only:
connect and sync are served, and every syncBack or update is answered with a
`FORBIDDEN` error without storing or forwarding its rows. A client without
local history sends no upload frame and therefore reaches `synced` as a reader.
Authorization never enters the replicated document; sub-pulse IDs prefixed by
their parent ID let a server derive routing and inherited roles from the ID.
Every frame names its document, so a transport may also multiplex several
document sessions over one connection and route by `docId`; the
[cloud session protocol](CLOUD.md) does this for every document of a root.
Unknown versions and kinds are rejected. A breaking
message change increments the envelope or operation version; application data
migrations increment the stored document version instead.

## Actor sequences, vectors and immutable rows

A vector is an array of `[sid:uint, clock:uint]` tuples, strictly sorted by
actor ID with no duplicates. Each clock is a positive, exclusive end of
contiguous, causally complete history. The empty vector means no known rows.
For example `[[65536, 4]]` covers actor transactions 1, 2 and 3.

```text
row:
  docId:string
  sid:uint
  clock:uint
  span:uint
  dependencies:vector
  operations:bytes
```

The envelope allows ranges `[clock, clock + span)` with `sid >= 65536`,
`clock >= 1`, `span >= 1` and a safe integer end. The current operation engine
requires **span = 1**: each actor starts at sequence 1 and increments once per
transaction, independently of the number of operations or characters it
contains. Observing another actor never creates a gap in this sequence.
Lamport time is a separate integer inside the payload.

An actor ID belongs to one writing replica at a time. It may pass to a later
replica, as when a browser tab closes and another one reuses its ID, only if
the new holder first obtains every row the ID has written to the document and
continues at the next sequence number: writing an older clock again forks the
actor's history. `pulsify-core` leases and reuses IDs this way; see
[Actor IDs](../packages/pulse/README.md#actor-ids).

Dependencies capture the complete applied frontier observed before the
transaction. A later transaction by the same actor declares its predecessor
end. Rows stay pending until their actor prefix is contiguous and every
cross-actor dependency is covered. A received maximum sequence is never
advertised as a completed frontier merely because its bytes are present.

Identity is `(docId, sid, clock)`. Contents and boundaries are immutable.
Exact retransmission is idempotent; changed contents at an existing identity,
overlapping ranges and actor forks are conflicts. A batch is accepted
atomically. To find missing rows, select `row.clock + row.span > peerClock`
for each actor, using zero for actors absent from the peer vector. Send the
original rows; this version does not negotiate slicing, resegmentation,
snapshots or compaction in exact envelopes 1/2; optional state deltas are described below.

The in-memory journal exposes copies through its public row APIs. Runtime-only
borrowed-row methods must not be exposed to callers or mutated. Relays can
validate and store the envelope without decoding document values. A client
prevalidates available operations, references, schema compatibility, constants
and metadata before committing its journal and applying the changes.

[Database adapters](STORAGE.md) use these range and dependency columns directly.
`appendEncoded` decodes the frame envelope once and stores the operation bytes
without reading or materializing the document. PostgreSQL performs append and
causal promotion in one database call. SQLite provides the same
logical interface. Database acceptance of an opaque row does not replace
application authorization or client-side operation validation.

## Operation payload version 3

The payload uses a fixed codec schema, not executable schemas from peers.
Its schema is defined in [operations.ts](../packages/pulse/source/core/operations.ts).

```text
version:uint = 3
lamport:uint
schema:string
ops:operation[]
```

`lamport` is positive and advances beyond the highest applied Lamport time
when a local transaction is generated. In document version 1, `schema` is empty
without a runtime schema, or the 32-character compatibility fingerprint of its
resolved codec layout graph, constant/frozen/rich-text annotations and tree roles. Versions 2+
produced by current definitions use `m<version>:<chainFingerprint>` instead.
This reuses the existing string field; operation payload and envelope versions
do not change. Historical V1 writes remain addressable by their original identity.
These fingerprints detect incompatibility; they are not authentication.

The chain uses the same four-stream 32-bit fingerprint function as layout hashes.
Its input is the codec encoding of `object({previous:"string", version:"uint",
schema:"string"})`. For V1, `previous` is the document kind; for version N > 1,
it is the full chain fingerprint at N - 1. `schema` is that version's layout hash,
or the empty string when no runtime schema was declared. Thus changing any prior
schema or annotation changes all subsequent identities. Callback source text is
deliberately excluded; a callback-only change with identical schemas is not
detectable. TypeScript-only shapes have no runtime layout to fingerprint.

Definitions cache these identities and the identity-to-version map once; documents
share them. Incoming current-version identities use the existing equality check,
historical versions use a map lookup. Unknown identities within a known version
raise `MIGRATION_DRIFT` before journal application; newer version numbers raise
`INCOMPATIBLE_DOCUMENT` instead. Compare the chain at the same version, not at
different peers' latest versions. Root metadata and migration version writes must
match their registered identity. Layout-only identities from old migrated clients
do not establish a verified chain: applications must explicitly upgrade those
histories; current definitions do not silently accept them as current versions.

Each operation starts with its numeric `kind:uint`, followed by these fields:

| Kind | Meaning | Fields in order |
| --- | --- | --- |
| 0 | Initialize or replace document root | value:encodedValue |
| 1 | Assign object register | target:string, field:fieldRef, value:encodedValue |
| 2 | Delete object register | target:string, field:fieldRef |
| 3 | Sequence insertion/deletion | target:string, after:string, deletes:string[], values:encodedValue[] |
| 4 | Replace an array entry's value | target:string, entry:string, value:encodedValue |
| 5 | Set or remove text attributes | target:string, entries:string[], attributes:codec-unknown |
| 6 | Move array entries | target:string, entries:string[], after:string |

All operation kinds use payload version 3. Encoders and decoders require this
version for ordinary, grouped and state envelopes. The Rust relay uses operations
version 3 in both its ordinary and grouped envelopes; inner rows remain opaque.

An array move allocates one new RGA position token per source entry, in source
order using the transaction's normal ordinal allocator. Each token references
the original logical entry and is chained after the preceding new token; the
first is anchored after `after`. Tokens participate in the immutable insertion
tree but contain no copied values or child nodes. Visible order traverses that
tree and emits an original entry only at its winning position, unless deleted.
The winning move uses `(lamport, actor, clock)` order; repeated moves of one
entry within one transaction use the last operation. Original entry IDs remain
the targets of replacement, deletion and nested edits. Position-token IDs can
be anchors but cannot be move sources or replacement/deletion targets. Move
sources must be distinct original entries in the same variable-length array;
tuples and text reject kind 6. Every source and anchor must be causally covered.

Deletes tombstone the logical element, so no move can resurrect it. A losing
position token remains a valid anchor, including for concurrent insertions made
after that position. A block's elements resolve positions independently under
overlapping concurrent moves. No sequence cycle can arise because every new
position references an already causally known token or an earlier token in the
same transaction; moves never rewrite an old token's insertion edge.

### Tree representation

`tree(elementSchema)` uses a codec map of records with `data:elementSchema`,
`location:{parent:string,position:string}` and `deleted:boolean`. Tree/node/location
roles participate in schema fingerprints; an ordinary map with the same fields
does not have the same public mutation contract. Payload data stays under stable
CRDT node IDs. A tree move replaces one complete location register using kind 1;
its parent and sibling position cannot merge independently. Direct mutations of
location fields, record removal/replacement and clearing a deletion flag are
rejected before journal application, including scalar/grouped fast paths.

Tree IDs created after initialization are `n<actor>:<clock>` with an optional
positive decimal collision suffix when importing snapshots. New ID keys are
immutable, and their prefix must match the creating transaction. Initialization
can restore existing IDs and tombstones. Positions are lowercase hexadecimal
strings made of four-character base-65536 digits, with a nonzero final digit.
Generated keys append the actor and clock (each padded to 14 hex characters),
then `0001`. Creation and move operations validate this suffix against their
transaction and cannot reuse a minted key within the same patch or a retained
key in the tree. Restoring snapshots also avoids collisions with existing ranks,
including tombstones. Initializers reject duplicate positions across nodes. Comparison is lexicographic, with
node ID as a deterministic fallback for ties.

The public forest is a pure projection of all winning location registers. A
missing parent becomes a root. Each parent cycle is broken by projecting its
lexicographically smallest node ID as a root; stored edges are not mutated.
Deleted nodes and descendants with deleted projected ancestors are hidden.
Thus an offline descendant move out can survive deletion of its previous
ancestor, while a move into a deleted subtree is hidden. Projection recomputes
from raw registers, so receive order and duplicate delivery cannot change the
final forest. This is a cycle-breaking LWW projection, not Loro/Kleppmann's
move-history algorithm. The API documentation describes its conflict outcomes.

`fieldRef` is an untagged codec union: variant index 0 followed by a string
key, or variant index 1 followed by a numeric field slot. Slots are zero-based
within an object layout, in codec field declaration order. A single-version
schema can use these slots; migration-capable definitions use string keys so
that earlier layouts retain their field identities.

Node and sequence-entry IDs are strings of the form `sid:clock:ordinal`.
Ordinal allocation follows deterministic traversal and operation order within
the creating transaction. Typed object traversal follows schema field order,
not the input object's property order. References must resolve to a known node
or entry and be covered by dependencies, or refer to a value created earlier
in the same transaction. The empty `after` string denotes the sequence head.

```text
encodedValue:
  layout:uint
  data:bytes
  constants:string[][]
  texts:string[][]
```

| Layout | Encoding of data |
| --- | --- |
| 0 | codec's `unknown` schema for supported generic document values |
| 1 | Root application schema extended with id:string, kind:string, version:uint, generation:uint |
| 2 and above | The selected definition's compiled layout at index `layout - 2`, using that layout's original codec schema |

The application schema is configured locally. It is not shipped with each
patch. `data` must be consumed completely by the selected codec. The same
application value can be encoded with that original codec schema outside
Pulsify. Root metadata and operation framing are additional protocol layers.

`constants` and `texts` are paths relative to this value, represented as string
segments; `[]` marks the whole value. They preserve captured constants and
rich-text initialization markers. Declared schema annotations (`constant`,
`frozen`, `constantPaths`, `richTextPaths`) are also applied by the compiled
layout; a frozen value is stored as one immutable value. Marker paths must resolve to present values, text
markers require strings, and constants cannot simultaneously be collaborative
text. Public generic values are finite numbers, bigint, well-formed Unicode strings,
booleans, null, undefined, dense arrays, plain objects and copied binary leaves.

## Collaborative semantics and schemas

Object fields are inline LWW registers. Their deterministic order is
`[lamport, sid, clock]`. Deletion retains its register stamp, so older writes
cannot resurrect it; a causally later assignment can reinsert it. Scalars do
not need separate collaborative node allocations.

Arrays and rich text use an RGA with stable entry IDs, insertion anchors and
permanent deletion tombstones. Concurrent insertions use the deterministic
stamp order at their shared anchor. Descendants of a deleted anchor retain
their place in the sequence. Kind 4 changes an existing array entry's LWW
value without creating an additional entry; concurrent replacements therefore
preserve cardinality. Updating a deleted entry does not resurrect it.

Plain string fields are atomic LWW values. Explicit rich-text fields create
one entry per Unicode code point, including an emoji as one position. Text
insertion/deletion uses kind 3; replacing a text entry through kind 4 is
rejected. Kind 5 applies independent LWW attributes to character IDs. `null`
or `undefined` removes an attribute. Plain snapshots and JSON output contain
the text string; `toDelta()` exposes runs and formatting. An insertion with
attributes emits insertion and formatting operations in the same atomic
transaction.

Root `id`, `kind` and generation zero are managed metadata. Version changes are
reserved for compatible registered migrations. Roots must be objects with the
expected identity and kind. Replacing a parent or entry value does not reattach
edits addressed to its old child; cached public views of detached children
become invalid.

Definitions compile field codecs, numeric slots, value checks and detached
copies once. Rejected local values do not advance the clock or journal. Remote
preflight validates affected values and graph references without cloning the
whole document for ordinary edits. Schema field order, float32 normalization,
constant, frozen and rich-text annotations must agree on all replicas.

A definition's schema registry retains the layout for each stored migration
version. Patches identify the layout they use, so a latest client can decode
old rows before running its deterministic migration chain. Migrations receive
detached input and emit collaborative changes. Existing constants cannot be
changed by a migration; converting a mutable field to a constant captures its
value in history, rather than merely relabeling its old editable node.
Keeping a field while removing its constant annotation is rejected before a
migration commits. A field omitted by a new schema may remain as immutable
legacy data; its old value is not made mutable by omitting it from the schema.
Materializers and migrator functions remain local code and are never sent to
the relay.

Published migration chains are append-only: once a step has been used, never
replace, remove or reorder it, or change its historical schema or transformation.
Corrections require a new version, including corrections that keep the same
schema. A document already at a version does not rerun earlier callbacks when
application code changes. Layout fingerprints do not identify migration behavior
and cannot detect a rewritten callback that keeps the same schema.

## Bounds, encoding and lifecycle

| Bound | Value |
| --- | --- |
| Frame bytes | 8 MiB |
| Operation payload per row | 1 MiB |
| Rows per message | 4096 |
| Vector entries | 1024 |
| Public input nesting | 32 levels |
| In-memory journal rows | 100,000 |
| In-memory received/cached bytes plus estimated row metadata | 64 MiB |

Local commits retain detached native operation values. Encoding occurs only
when an export requests a row's bytes; later exports reuse the cache and the
native patch reference is released. Row count and metadata capacity are
checked before local commit. Encoded patch and cached-history limits are
checked at export. An oversized patch can remain usable locally while its
export fails with `LIMIT_EXCEEDED`. These bounds are not a process RSS limit.

Frames have size and complete-consumption checks. Generated schema checks
validate application values and operation consistency; envelope decoding uses
codec directly without a separate recursive envelope-validation traversal.
The common scalar-write codec has a specialized path that preserves exactly
the same bytes as its declared schema. Uncommon operations use the compiled
schema codec.

Outgoing rows are chunked near 2 MiB, within the per-message row limit and the
Rust relay's 300,000-node structural budget. The chunker reserves room for the
largest vector and frame metadata. Transport cancellation rejects unfinished
initialization and removes listeners. A connected client retries a lost
transport with backoff; every reconnection starts a fresh session that assumes
nothing about the peer: a connect with the local vector, then uploads of every
row the peer does not acknowledge, from retained journal history. Peers must
therefore accept repeated connects, on new sessions and within one (liveness
probes), and exact retransmissions, which the idempotent journal guarantees. Generation zero remains the only supported
generation. Applications must plan retention and compaction before reaching
history bounds; silently dropping rows required by offline replicas is not
supported.

## Optional grouped transport (envelope 2, payload 3)

Envelope 1 remains the default. Envelope 2 carries
one homogeneous, lossless run in a sync, syncBack or update message:

```text
2, 3, kind, docId:string, requestId:uint,
[found:boolean, complete:boolean only for kind 2], vv:vector,
sid:uint, clockStart:uint, count:uint, lamportStart:uint,
schema:string, target:string, fieldTag:uint, field:string|uint,
layout:uint, externalDependencies:vector,
count × length-prefixed original value bytes
```

Strings, integers, booleans, vectors and binary lengths use the same codec
primitives as envelope 1. Run integers use canonical varints; header strings use
strict UTF-8. Count is 2–4096. Each original row has span 1, clock `clockStart+i`,
Lamport `lamportStart+i`, the same target/field/layout/schema and no value markers.
Its dependencies are the external vector plus `(sid, clockStart+i)` whenever that
clock is greater than 1. The external vector cannot contain `sid`.

Reconstruction writes the canonical payload-3 single-put header followed by the
original value bytes and the two empty marker arrays. It preserves every row
identity, dependency vector and payload byte. A partial frontier can select a
suffix; forwarding preserves the raw values, without decoding/re-encoding them.
Rust expands runs into ordinary opaque rows without an application schema.
Storage ingress uses the same decoder and persists the original rows; its schema
and one-call append contract are unchanged. Expansion does add header construction
at storage/envelope boundaries, without reading any document.

The current native producer groups only string/float64 object-field writes in a
single-version typed document. Managed fields, constants, rich text, migrations,
container changes and mixed runs use envelope 1. A new contiguous, causally ready
run validates its shared context once and **every** value before the journal
advances. Only the final LWW write needs application; all intermediate rows remain
independently queryable and replayable. Duplicates, overlaps, gaps and pending
history use the general row path, including its atomic preflight.

Frame, row, vector and expanded structure/byte limits apply before allocating
individual rows. The journal charges expanded history plus its owned frame once;
materializing exact row bytes later does not charge again. Decoded run rows are
immutable and expose detached operation bytes/dependency vectors to callers.

### Capability boundary

`exportPulseUpdates(pulse, remoteVV, {peerVersion: 2})` and
`applyPulseUpdates(pulse, frames)` are the public exchange path also used by
Connection. Omit `peerVersion` for an unknown endpoint: output remains v1.
In-process peers can consult `SUPPORTED_PROTOCOL_VERSIONS`; a custom connector
sets `ConnectorSession.protocolVersion` only after establishing endpoint support.

The current memory connector knows its PulseRelay's capability. The reference
relay's `open(send, {protocolVersion: 2})` declares a supporting session; its default
is 1. Each recipient receives its declared format, including old subscribers.

WebSocket stays v1, with **no subprotocol offer**, by default. For a known upgraded
server, opt in with `createWebSocketConnector(url, undefined, {protocolVersion: 2})`.
It offers `pulsify-v2`/`pulsify-v1` and uses v2 only if the socket selected
`pulsify-v2`. This explicit endpoint opt-in matters: some Bun servers automatically
select the first offered subprotocol even when the application does not understand
it. The example server and client explicitly configure both ends. A peer must
never infer application capability solely from such an automatic selection.

## Optional state deltas (envelope 3)

Envelope 3 is an explicitly negotiated transport view; operation payload version
remains 3. It does **not** replace the exact append-only database journal.
`SUPPORTED_PROTOCOL_VERSIONS` is `[1, 2, 3, 4]`; 4 adds the compact write below to
the state behavior. Unknown peers still receive envelope 1.
A known upgraded WebSocket server may opt into `protocolVersion: 3` and select
`pulsify-v3`; the client also offers v2/v1. Never infer this capability from a
successful socket opening. The Rust relay currently supports exact envelopes
1/2 and rejects 3; use a v1/v2 session with it.

The initial implementation condenses homogeneous runs of at least 32 overwritten
string/float64 object registers. Actor clocks, Lamport progression, schema,
target, field, layout and external dependencies must agree throughout the run.
Constants, rich text, arrays, container replacements and definitions with
migration history keep exact operations. Small changes also keep exact rows.
The local journal maintains its latest native scalar tail incrementally, so
exporting this common case does not scan the overwritten transactions.

All following fields use the scalar encodings above, in this exact order:

```text
protocolVersion:uint = 3
operationsVersion:uint = 3
kind:uint = 1 | 2 | 4
docId:string
requestId:uint
vv:vector

kind 1: historyOnly:boolean
kind 2: found:boolean, complete:boolean, delta:stateDelta
kind 4: delta:stateDelta

stateDelta:
  sid:uint, clock:uint, count:uint, lamport:uint
  schema:string, target:string, field:fieldRef, layout:uint
  external:vector
  data:bytes  // final register value, encoded by its compiled codec layout
```

The covered actor range is `[clock, clock + count)`; `lamport` belongs to its
first transaction. The final original row is reconstructed exactly and retained;
intermediate overwritten values are absent at the receiver. No synthetic row
pretends to span their history. Frames are canonical, bounded, schema-checked,
and require the prior causal base. Missing bases fail with
`HISTORY_UNAVAILABLE`; ordered delivery or a new synchronization is required.
Overlapping state and later exact history must agree on the run metadata and
known winner. Hidden historical values are not validated by receiving their
final state; they remain available for audit in the authoritative exact journal.

`getPulseVersions(pulse)` distinguishes `state` (causally covered applied state)
from `history` (contiguous physically retained per-actor operation prefixes).
The latter is a physical inventory and need not be causally closed across
actors when pending rows exist. Local edits depend on **state**, preserving
causality after condensation. Exact exports that would cross a state-only hole
fail with `HISTORY_UNAVAILABLE`, rather than advertise absent operations.

`exportPulseUpdates(pulse, vv, {peerVersion: 3})` may select state deltas.
`{mode: "history"}` always requires exact rows. Connection uploads always use
this exact mode (envelopes 1/2), even in a v3 session. The relay and every
`appendEncoded` database adapter reject state-only uploads. The relay can
condense retained grouped runs during v3 initial downloads; broadcasts remain
exact. Plain rows recovered from storage, or a mixed initial upload containing
creation plus edits, currently retain the exact fallback: the opaque relay does
not guess a schema from their binary payloads.

Call `recoverPulseHistory(pulse)` to request omitted rows from connected sources.
A v3 connect with `historyOnly = true` uses the physical history vector and
receives exact rows. Recovery succeeds only when physical history covers the
state vector captured at its start; missing/lost sources produce an explicit
error. Connecting to an older endpoint automatically requests the physical
vector to backfill first. A partial client cannot seed a new authoritative
server without first obtaining the missing exact history.

`decodeMessage` preserves state ownership internally: use `applyPulseUpdates`
(or re-encode the same message with `peerVersion: 3`), rather than copying its
`rows` array. Its empty row array represents state coverage, not an empty exact
journal. Storage callers should use `rowsFromFrame`/`appendEncoded`, which reject
this distinction safely. Database schemas and queries remain unchanged.

## Optional compact writes (envelope 4)

Envelope 4 carries **one** scalar register write between two pulses of the same
document, for example a live edit exchanged with
`exportPulseUpdates(pulse, vv, {peerVersion: 4})` and `applyPulseUpdates`. It is
a transport view like envelope 3: the receiver rebuilds the exact original row,
byte for byte, so journals, storage and later exports are unchanged. Relays,
`decodeMessage`, database adapters and the Rust crate reject it as an unsupported
version; connector sessions stay on envelopes 1 to 3.

```text
protocolVersion:uint = 4
operationsVersion:uint = 3
flags:uint                 // 1 request, 2 vector, 4 external, 8 named, 16 integer
docId:string
[requestId:uint]           // flag 1; zero otherwise
sid:uint, clock:uint
lamportOffset:uint         // lamport - clock
[external:vector]          // flag 4; empty otherwise
[vv:vector]                // flag 2
targetActor:uint           // 0 = sid, i = external[i - 1].sid
targetClock:uint, targetSerial:uint
field:uint | string        // string with flag 8
value                      // uint with flag 16, else the original value bytes to the end of the frame
```

The frame is always an update (kind 4) with one row of span 1. What it leaves
out is derived:

- **Dependencies** are `external` plus `(sid, clock)` when `clock > 1`, as in
  envelope 2.
- **The sender vector** is `external` plus `(sid, clock + 1)` unless flag 2
  carries a different one.
- **The target** is the node ID `actor:clock:serial`. Its creator is always the
  writer or one of its external dependencies, since a write must causally cover
  its target.
- **Schema identity and value layout** are those of the row that created the
  target. Only documents with a single schema version produce this envelope, and
  every row of such a document carries the same identity, which a receiver
  verified when it applied the creating row. The receiver therefore uses its own
  identity and the layout of the addressed field.
- **The value** with flag 16 is a non-negative safe integer whose original
  bytes are its little-endian float64. This is a rule on bytes, not on types:
  any eight value bytes that read as such an integer use it.

Producers use it for a lone string or float64 object-field write, the same
fields as envelopes 2 and 3, when exactly one row is missing and no state
summary is pending. Everything else keeps the earlier envelopes, including
`{mode: "history"}` exports. A receiver that does not hold the target fails with
`HISTORY_UNAVAILABLE`; one whose definition has a migration history, or whose
field is not a plain scalar, fails with `INCOMPATIBLE_DOCUMENT`. Re-export with
`peerVersion: 3` for such a peer.

Frames are canonical: integers are minimal varints, unknown flags, an empty
flagged vector, a zero flagged request ID, a flagged vector equal to the derived
one and an unflagged integer value are rejected, as are trailing bytes. The
frame, vector and expanded payload bounds of envelope 2 apply.
