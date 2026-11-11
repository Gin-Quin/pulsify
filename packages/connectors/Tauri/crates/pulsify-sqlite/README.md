# pulsify-sqlite

A SQLite patch store and frame relay for
[Pulsify](https://www.npmjs.com/package/pulsify-core) documents, without any
UI framework. It is the engine of
[`tauri-plugin-pulsify`](https://crates.io/crates/tauri-plugin-pulsify), and
usable on its own in any Rust process that persists Pulsify documents locally.

- `SqliteStore`: the patch journal, file-compatible with the TypeScript
  `SqlitePatchStore`; either side can open a database written by the other.
- `relay_frame`: answers a client frame (connect, upload) from the store,
  without decoding the CRDT operations.
- `Hub`: sessions pinned to one document each, sharing one connection; rows
  stored by one session reach the document's other sessions.

```rust
use pulsify_sqlite::SqliteStore;

let store = SqliteStore::open("pulsify.sqlite")?;
```

Frames are the binary Pulsify protocol of the
[`pulsify-protocol`](https://crates.io/crates/pulsify-protocol) crate.

## License

Apache-2.0
