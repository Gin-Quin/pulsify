# Pulsify binary protocol

Envelope version **1**, operation payload version **2**. The native core has no
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
operationsVersion:uint = 2
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
`INCOMPATIBLE_DOCUMENT`, `CLOSED`, `TIMEOUT`, `CONNECTION_FAILED`, `CONFLICT`
and `LIMIT_EXCEEDED`. Unknown versions and kinds are rejected. A breaking
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
snapshots or compaction.

The in-memory journal exposes copies through its public row APIs. Runtime-only
borrowed-row methods must not be exposed to callers or mutated. Relays can
validate and store the envelope without decoding document values. A client
prevalidates available operations, references, schema compatibility, constants
and metadata before committing its journal and applying the changes.

[Database adapters](STORAGE.md) use these range and dependency columns directly.
`appendEncoded` decodes the frame envelope once and stores the operation bytes
without reading or materializing the document. PostgreSQL performs append and
causal promotion in one database call. SQLite and FoundationDB provide the same
logical interface. Database acceptance of an opaque row does not replace
application authorization or client-side operation validation.

## Operation payload version 2

The payload uses a fixed codec schema, not executable schemas from peers.
Its schema is defined in [operations.ts](../packages/pulse/source/core/operations.ts).

```text
version:uint = 2
lamport:uint
schema:string
ops:operation[]
```

`lamport` is positive and advances beyond the highest applied Lamport time
when a local transaction is generated. `schema` is empty for the legacy typed
TypeScript API without a runtime schema. Otherwise it is the definition's
32-character compatibility fingerprint. The fingerprint includes the resolved
codec layout graph and constant/rich-text annotations. It detects incompatible
layouts; it is not an authentication mechanism.

Each operation starts with its numeric `kind:uint`, followed by these fields:

| Kind | Meaning | Fields in order |
| --- | --- | --- |
| 0 | Initialize or replace document root | value:encodedValue |
| 1 | Assign object register | target:string, field:fieldRef, value:encodedValue |
| 2 | Delete object register | target:string, field:fieldRef |
| 3 | Sequence insertion/deletion | target:string, after:string, deletes:string[], values:encodedValue[] |
| 4 | Replace an array entry's value | target:string, entry:string, value:encodedValue |
| 5 | Set or remove text attributes | target:string, entries:string[], attributes:codec-unknown |

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
segments; `[]` marks the whole value. They preserve explicit struct/tuple and
rich-text initialization markers. Declared schema annotations are also applied
by the compiled layout. Marker paths must resolve to present values, text
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
attributes emits an insertion transaction followed by its dependent formatting
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
constant annotations and rich-text annotations must agree on all replicas.

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
initialization and removes listeners. Reconnection starts fresh sessions and
uses retained journal history. Generation zero remains the only supported
generation. Applications must plan retention and compaction before reaching
history bounds; silently dropping rows required by offline replicas is not
supported.
