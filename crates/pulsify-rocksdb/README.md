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

An append is one atomic RocksDB write batch: the rows, the clocks they advance,
the pending entries and the register index are stored together or not at all,
and a refused batch writes nothing. By default the write-ahead log is synced before `append`
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

The column families below use keys that start with the document ID and a NUL
(which an ID cannot contain), followed by big-endian integers:

| Column family | Key | Value |
| --- | --- | --- |
| `rows` | `doc_id NUL sid clock` | format byte `0`, span, dependencies (varuints), operations, or a packed segment |
| `clocks` | `doc_id NUL sid` | the actor's committed clock |
| `pending` | `doc_id NUL sid clock` | format byte `0`, span, dependencies of a row that is not ready |
| `tombstones` | deleted document prefix | permanent deletion marker |
| `values` | `doc_id NUL sid register` | clock (big-endian), then the row as `rows` encodes it: an actor's newest write to a field without history |

A row is ready when it starts before its actor's clock, so promoting a pending
row moves the clock and deletes the `pending` entry without rewriting the row.

A field without history keeps each actor's newest write to it, as
[the protocol](https://github.com/Gin-Quin/pulsify/blob/main/docs/PROTOCOL.md#fields-without-history)
describes: `values` holds it under its actor and its register, the encoded
target and field of the write, and the actor's next write to the register
overwrites it with one `put`. The sequence numbers of overwritten writes hold
nothing; spans are computed when rows are read, and a gap row is served where
no row precedes them. Blob garbage collection is enabled for what overwrites
leave in blob files. A database written by this version cannot be opened by an
earlier one, which does not know the `values` column family.

A RocksDB database is not readable by the SQLite stores, nor the reverse.

### Pack history on append

Packing is on by default. To write ordinary rows, opt out after opening
the store and before appending.

```rust
let mut store = RocksStore::open("pulsify.rocksdb")?;
store.set_pack_appends(false);
```

Packing groups 8 to 64 consecutive ready history rows of one actor from the
same append under the first row's key. Each segment is
smaller than 4 KiB and contains format byte `1` followed by length-prefixed
ordinary rows. Each span gives the next row's clock. Reads decode the segment
and return the original operations and dependencies. The segment and the
frontier commit in the same RocksDB write batch.

The store reads ordinary rows in existing databases directly. Before the first
packed write it creates an empty `packed_layout` column family, which makes
older versions refuse to open the directory. During a rollout, call
`set_pack_appends(false)` after each open until all readers are upgraded.
Disabling packing affects new writes. The store continues to read any packed
segments already in the database.

## Tests and benchmark

```sh
cargo test --manifest-path crates/pulsify-rocksdb/Cargo.toml
cargo bench --manifest-path crates/pulsify-rocksdb/Cargo.toml
bun test tests/rocksdb.test.ts
```

The Rust tests run one behaviour suite against `RocksStore` and `SqliteStore`,
then apply random histories (gaps, dependencies, resends, conflicts, forks,
replaced writes and the spans that cover them) to both and require identical
answers, and let replicas with the journal of `pulsify-protocol` converge
through both. The benchmark prints both stores side by
side. The Bun test builds the `pulsify-rocksdb` harness binary and drives real
documents through it.

Building needs a C++ compiler and libclang, as the
[`rocksdb`](https://crates.io/crates/rocksdb) crate does.

## License

Apache-2.0

Permanent lifecycle operations are available through `pulsify_protocol::DocumentStore`:
`delete_documents(prefix, false)` purges and permanently retires a subtree;
`delete_documents(prefix, true)` retains rows exclusively for `recover_rows`.
`documents` enumerates live subtree IDs. Reads and uploads to deleted IDs return
`NOT_FOUND`, including previously unseen descendants and after a database restart.
Deletion always syncs the WAL. Deleted IDs and their descendants cannot be reused.
