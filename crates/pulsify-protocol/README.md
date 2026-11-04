# pulsify-protocol

An independent Rust implementation of the Pulsify v1 envelope, version vectors, immutable causal patch journal and single-peer reference relay. The library has no runtime dependencies; `serde_json` is used only by fixture tests.

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

The crate stores operation payloads as opaque bytes. It validates the envelope and causal metadata, buffers gaps and handles exact retransmissions. Applying CRDT operations, verifying their inner spans, authorizing document access, storing data durably and broadcasting across multiple peers belong to the embedding application. The TypeScript interoperability test verifies a real create/load/offline-edit cycle against the Rust relay.

See [the protocol specification](../../docs/PROTOCOL.md) and [shared fixtures](../../fixtures/protocol.json).
