# pulsify-rocksdb

A RocksDB patch store and frame relay for
[Pulsify](https://www.npmjs.com/package/pulsify-core) documents, without any
UI framework. It behaves like
[`pulsify-sqlite`](https://crates.io/crates/pulsify-sqlite): the same rows are
accepted, refused, kept pending and returned, with the same errors. Use it in
a Rust process that persists Pulsify documents and wants RocksDB's write
throughput and compression.

- `RocksStore`: the patch journal. `append`, `vector`, `missing` and
  `sync_state` have the signatures and semantics of `SqliteStore`.
- `relay_frame`: answers a client frame (connect, upload) from the store,
  without decoding the CRDT operations.
- `Hub`: sessions pinned to one document each, sharing one store; rows
  stored by one session reach the document's other sessions.

```rust
use pulsify_rocksdb::{RocksOptions, RocksStore};

let store = RocksStore::open("pulsify.rocksdb")?;
// Or trade the sync of each append for speed:
let options = RocksOptions { sync: false, ..RocksOptions::default() };
let store = RocksStore::open_with("pulsify.rocksdb", &options)?;
```

Frames are the binary Pulsify protocol of the
[`pulsify-protocol`](https://crates.io/crates/pulsify-protocol) crate, which
also defines the `PatchStore` trait both stores implement.

## Durability and concurrency

An append is one atomic RocksDB write batch: the rows, the clocks they advance
and the pending entries are stored together or not at all, and a refused batch
writes nothing. By default the write-ahead log is synced before `append`
returns, like SQLite's `synchronous=FULL`. With `sync: false`, a power loss
can lose the last appends, never corrupt the database; a process crash loses
nothing.

A store owns its database: RocksDB locks the directory, so a second process
(or a second `RocksStore`) cannot open it. `append` takes `&mut self`; put the
store in a `Mutex` or a `Hub` to share it between threads. Because nothing
else writes, the store keeps the vector and the pending rows of the documents
it used last in memory (`cached_documents`, 1024 by default): an in-order
append reads nothing from the database.

## Layout

Three column families, whose keys all start with the document ID and a NUL
(which an ID cannot contain), followed by big-endian integers:

| Column family | Key | Value |
| --- | --- | --- |
| `rows` | `doc_id NUL sid clock` | format byte `0`, span, dependencies (varuints), operations |
| `clocks` | `doc_id NUL sid` | the actor's committed clock |
| `pending` | `doc_id NUL sid clock` | format byte `0`, span, dependencies of a row that is not ready |

A row is ready when it starts before its actor's clock, so promoting a pending
row moves the clock and deletes the `pending` entry without rewriting the row.

Rows are not packed into segments as `SqlitePatchStore.compact` does: RocksDB
already stores consecutive keys in shared, compressed blocks, and a full read
is one sequential scan. The format byte leaves room for packed values later.
A RocksDB database is not readable by the SQLite stores, nor the reverse.

## Tests and benchmark

```sh
cargo test --manifest-path crates/pulsify-rocksdb/Cargo.toml
cargo bench --manifest-path crates/pulsify-rocksdb/Cargo.toml
bun test tests/rocksdb.test.ts
```

The Rust tests run one behaviour suite against `RocksStore` and `SqliteStore`,
then apply random histories (gaps, dependencies, resends, conflicts, forks) to
both and require identical answers. The benchmark prints both stores side by
side. The Bun test builds the `pulsify-rocksdb` harness binary and drives real
documents through it.

Building needs a C++ compiler and libclang, as the
[`rocksdb`](https://crates.io/crates/rocksdb) crate does.

## License

Apache-2.0
