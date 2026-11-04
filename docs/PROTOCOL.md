# Pulsify binary protocol v1

Protocol version **1**, operations format version **1**. The reference TypeScript implementation uses `@gin-quin/codec` 2.1.0, pinned in the lockfile. The [Rust crate](../crates/pulsify-protocol) implements the envelope independently. [Shared byte fixtures](../fixtures/protocol.json) are the compatibility authority. Regenerate them only for intentional additions or breaking changes with `bun scripts/generate-fixtures.ts`.

## Scalar encoding

- `uint`: canonical unsigned base-128 varint, seven payload bits per byte, high bit means continuation. All integers in the envelope and operation timestamps are in `[0, 2^53 - 1]`.
- `string`: `uint` UTF-8 byte length followed by well-formed UTF-8. IDs are opaque strings; they need not be UUIDs.
- `boolean`: one byte, exactly 0 or 1.
- `bytes`: `uint` byte length followed by those bytes.
- Arrays: `uint` element count, then the elements. Tuples have no element-count prefix.
- Optional values: one presence byte (0 or 1), then the value if present.
- Objects encode fields in the exact order below. There are no property names or padding on the wire.

A WebSocket message is one complete Pulsify frame. Other transports must provide framing themselves; for byte streams, a length prefix outside this format is a suitable adapter. Arbitrary concatenation is rejected as trailing data.

## Frame

```text
protocolVersion:uint = 1
operationsVersion:uint = 1
kind:uint
...variant fields
```

Every variant starts with `docId:string, requestId:uint` in that order.

| Kind | Name | Remaining fields, in wire order |
| --- | --- | --- |
| 1 | connect | vv:vector |
| 2 | sync | found:boolean, complete:boolean, vv:vector, rows:row[] |
| 3 | syncBack | vv:vector, rows:row[] |
| 4 | update | vv:vector, rows:row[] |
| 5 | ack | vv:vector |
| 6 | error | code:string, message:string |

`requestId` identifies a request within a session. Server pushes use update with request ID zero. A connect request can receive several sync pages with the same request ID; only the final page has `complete = true`. A write receives ack only after the reference journal accepts it. Ack guarantees the reference journal's in-memory acceptance, not disk durability; a durable implementation must commit its storage before acknowledging.

One session subscribes to one document. Error codes include `INVALID_MESSAGE`, `UNSUPPORTED_VERSION`, `NOT_FOUND`, `INCOMPATIBLE_DOCUMENT`, `CLOSED`, `TIMEOUT`, `CONNECTION_FAILED`, `CONFLICT` and `LIMIT_EXCEEDED`. Unknown versions and kinds are rejected. An incompatible wire change requires a protocol/operations version increment; a document migration increments its stored `version` instead.

## Vectors and immutable patch rows

A vector is an array of `[sid:uint, clock:uint]` tuples, strictly sorted by actor ID with no duplicates. Its clocks are positive, exclusive ends of causally complete segments. An empty vector means no known history. A row encodes:

```text
docId:string
sid:uint
clock:uint
span:uint
dependencies:vector
operations:bytes
```

`sid >= 65536`; `clock >= 1`; `span >= 1`; `clock + span <= 2^53 - 1`. A row covers `[clock, clock + span)`. It has an immutable identity `(docId, sid, clock)` and immutable contents. Exact retransmission is idempotent. Different bytes/metadata at the same ID, partial overlap, or a fork of one actor's chain is rejected.

Dependencies are the complete applied frontier observed immediately before generating the patch. The actor's own dependency identifies the prior segment end. Lamport timestamps may jump after observing another actor, so arithmetic adjacency alone cannot detect missing history. The first segment of a new actor may start above 1.

Keep received rows pending until every dependency is covered. Apply available rows in causal order, then advance the advertised vector. Do not advertise the maximum timestamp merely seen. Use `row.end > peerClock` to choose rows for retransmission. Send the original whole rows, preserving boundaries, IDs, dependencies and encoded bytes; v1 does not allow resegmentation of an existing actor's history.

Relays may buffer rows without interpreting operations. A CRDT client validates span metadata and root metadata changes before applying available rows once. Ordinary edits do not clone or traverse the document. Compatibility checks inspect only root identity, kind, migration version and generation. Clients also reject operation references not covered by the declared dependencies or earlier operations in the same patch. Clients forward newly learned history to their other connectors. Reference relays broadcast new rows and acknowledge uploads; duplicate uploads produce no new broadcast.

The root and its metadata have exclusive node ownership. A metadata update creates a fresh constant, or retains that same field's current constant; it cannot reuse a node from another field. Other fields cannot reference the root or its metadata nodes. This avoids json-joy garbage collection of shared nodes removing document identity. These checks inspect changed links and the four metadata references, without traversing document contents.

## Operation payload format v1

The payload is an array of tagged operations. Each operation starts with its mnemonic as a `string`; only the corresponding fields follow. JSON Joy's verbose operations are normalized to the fixed schemas below, then encoded with codec. Runtime schemas and engine class instances are never transmitted.

`timestamp` is an untagged union: `uint` variant index 0 followed by `[sid:uint, time:uint]`, or index 1 followed by a single `uint` time for reserved server session ID 1. `[0, 0]` denotes the origin. `timespan` is `[sid:uint, time:uint, span:uint]`.

| Mnemonic | Fields in order |
| --- | --- |
| new_con | value:optional(portableValue), timestamp:optional(boolean) |
| new_val, new_obj, new_vec, new_str, new_bin, new_arr | none |
| ins_val | obj:timestamp, value:timestamp |
| ins_obj | obj:timestamp, value:array([key:string, value:timestamp]) |
| ins_vec | obj:timestamp, value:array([index:uint, value:timestamp]) |
| ins_str | obj:timestamp, after:timestamp, value:string |
| ins_bin | obj:timestamp, after:timestamp, value:string (base64) |
| ins_arr | obj:timestamp, after:timestamp, values:timestamp[] |
| upd_arr | obj:timestamp, ref:timestamp, value:timestamp |
| del | obj:timestamp, what:timespan[] |
| nop | len:optional(uint), default 1 |

The `new_con.timestamp` flag means its value is a timestamp. Its value still uses the portable constant encoding; the decoder validates the resulting integer or two-integer array. The canonical TypeScript encoder represents undefined constants with a present portable undefined value. A missing value also decodes as undefined.

A portable value starts with `kind:uint`:

| Kind | Value | Remaining fields |
| --- | --- | --- |
| 0 | null | none |
| 1 | undefined | none |
| 2 | boolean | value:boolean |
| 3 | finite number | value:IEEE 754 float64, little-endian |
| 4 | string | value:string |
| 5 | array | items:portableValue[] |
| 6 | object | entries:array([key:string, value:portableValue]) |
| 7 | binary | value:bytes |

Object entries have unique keys. This vocabulary avoids executable schema discovery and preserves undefined and binary constants. The current public document API uses a narrower JSON-like subset. Operation span follows JSON Joy semantics; string insert spans count UTF-16 code units, not UTF-8 bytes. A no-op span is positive. Empty inserts that produce inconsistent spans are rejected.

The Rust reference relays inner payloads unchanged; it does not materialize documents or execute migrations. Implementing a Rust CRDT engine requires the same JSON CRDT operation semantics in addition to this envelope contract.

## Bounds and lifecycle

- Maximum frame: 8 MiB; operation payload per row: 1 MiB.
- Maximum rows per message: 4096; vector entries: 1024.
- Public JSON/constant input nesting: 32 levels.
- Reference document history: 100,000 rows. Received bytes, cached local bytes and row metadata are additionally limited to 64 MiB. Native patches are retained without encoding until an export requests their bytes; their binary size is checked then. These are journal bounds, not a process RSS bound.
- Sync responses and uploads are chunked near 2 MiB and within the Rust relay's 300,000-node structural budget, reserving room for the maximum envelope vector and framing. Both reference relays use this batching policy.

TypeScript delegates schema encoding and decoding directly to codec, without an additional schema traversal or byte preflight. Local commits retain their native patch; portable conversion and encoding occur only when wire rows are requested, then the bytes are cached and the native patch reference is released. Frame and encoded-patch limits apply at that boundary, so an oversized native patch can be committed locally but cannot be exported. Pulsify checks frame size, complete consumption (trailing bytes), protocol versions and CRDT consistency. The scalar definitions above describe valid wire data; acceptance of malformed scalar encodings follows codec's behavior. The independent Rust decoder retains strict scalar checks and a 100,000-item collection limit. Wire rows own copies of their bytes so callers cannot mutate journal contents through input/output rows. Transport cancellation rejects pending initialization and removes listeners. Reconnection uses fresh session state and retained journal history.

Snapshots and compaction are not negotiated in v1. Before a history bound is reached, applications need an explicit retention/next-protocol strategy rather than silently dropping history still needed by offline clients. Generation zero is the only supported document generation.
