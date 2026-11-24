# pulsify-protocol

An independent Rust implementation of the Pulsify v1 envelope and v2 grouped input, version vectors, causal patch journal and single-peer reference relay. The library has no runtime dependencies; `serde_json` is used only by fixture tests.

All supported envelopes use operations version 3. Earlier operation versions are
rejected. Inner operation payloads stay opaque to this relay.

```rust
use pulsify_protocol::{encode, decode, Body, Message};

let message = Message {
    doc_id: "example".into(),
    request_id: 1,
    body: Body::Connect { vv: vec![] },
};
assert_eq!(decode(&encode(&message).unwrap()).unwrap(), message);
```

```sh
cargo test --manifest-path crates/pulsify-protocol/Cargo.toml
cargo run --manifest-path crates/pulsify-protocol/Cargo.toml -- sample
```

The CLI accepts one hex frame per stdin line. `roundtrip` decodes and re-encodes each frame; `relay` retains an in-memory document journal for that process and responds to connect/uploads. Hex is only a testing transport; the protocol itself is binary.

For durable stores, the `PatchStore` trait describes what `pulsify-sqlite` and `pulsify-rocksdb` implement; `relay_frame` serves one frame from any of them, and `Hub` adds sessions pinned to a document with broadcast to the document's other sessions; rows it stored are forwarded even when the sender's own sink is gone.

The crate stores operation payloads as opaque bytes, except for the head of a last-value row: `last_register_of` reads the register and the Lamport time of a write to a field without history (operation kinds 7 and 8), and `is_gap` recognizes a gap row, without a schema. The journal keeps the newest row of each such register, as `docs/PROTOCOL.md` ("Fields without history") describes. It validates the envelope and causal metadata, buffers gaps and handles retransmissions. Applying CRDT operations, verifying their inner spans, authorizing document access, storing data durably and broadcasting across multiple peers belong to the embedding application. The TypeScript interoperability test verifies a real create/load/offline-edit cycle against the Rust relay.

The protocol specification (`docs/PROTOCOL.md`) and the shared fixtures (`fixtures/protocol.json`) live in the Pulsify repository.

Envelope-2 runs expand into exact v1 rows without decoding application values. The CLI and reference relay emit v1, preserving existing consumers; a host advertising v2 must ensure its transport capability contract matches this decoder.
