//! LevelDB: RocksDB's ancestor, through the same layout as `kv.rs`.
//!
//! It has atomic write batches and snapshots, but no transactions and no lock
//! manager. The document lock is therefore a striped mutex in this process,
//! which is what RocksDB's `TransactionDB` supplies inside the library. A
//! writer's buffered changes become one write batch.
use super::kv::{self, Key, Kv};
use super::{Output, Session, Work};
use anyhow::Result;
use leveldb::batch::{Batch, Writebatch};
use leveldb::compaction::Compaction;
use leveldb::database::Database;
use leveldb::iterator::{Iterable, LevelDBIterator};
use leveldb::kv::KV;
use leveldb::options::{Options, ReadOptions, WriteOptions};
use leveldb::snapshots::{Snapshot, Snapshots};
use std::sync::Arc;

pub struct Bytes(Vec<u8>);
impl db_key::Key for Bytes {
    fn from_u8(key: &[u8]) -> Self {
        Self(key.to_vec())
    }
    fn as_slice<T, F: Fn(&[u8]) -> T>(&self, f: F) -> T {
        f(&self.0)
    }
}

/// RocksDB's default memtable size; LevelDB's own default is 4 MiB.
pub const WRITE_BUFFER_BYTES: usize = 64 << 20;
pub struct Shared {
    db: Database<Bytes>,
    locks: kv::Locks,
}
/// One process-wide database; every worker shares it.
pub struct LevelDb(pub Arc<Shared>, pub bool);
pub fn open(path: &str) -> Result<Arc<Shared>> {
    let mut options = Options::new();
    options.create_if_missing = true;
    options.write_buffer_size = Some(WRITE_BUFFER_BYTES);
    Ok(Arc::new(Shared {
        db: Database::open(std::path::Path::new(path), options)?,
        locks: kv::Locks::default(),
    }))
}

struct Tx<'a> {
    db: &'a Database<Bytes>,
    snapshot: Option<Snapshot<'a, Bytes>>,
    doc: &'a str,
    buffer: kv::Buffer,
}
impl<'a> Tx<'a> {
    fn options(&'a self) -> ReadOptions<'a, Bytes> {
        let mut options = ReadOptions::new();
        options.snapshot = self.snapshot.as_ref();
        options
    }
}
impl Kv for Tx<'_> {
    fn vector(&mut self) -> Result<Option<Vec<u8>>> {
        Ok(self
            .db
            .get(self.options(), Bytes(kv::vector_key(self.doc)))?)
    }
    fn set_vector(&mut self, value: &[u8]) -> Result<()> {
        self.buffer.vector = Some(value.to_vec());
        Ok(())
    }
    fn scan(&mut self, from: Key, to: Key, limit: usize, visit: &mut kv::Visit<'_>) -> Result<()> {
        let prefix = kv::segment_prefix(self.doc);
        let start = Bytes([&prefix[..], &from].concat());
        let end = [&prefix[..], &to].concat();
        // Buffered writes can hide or add entries, so only an empty buffer may limit.
        let stored_limit = if self.buffer.pending.is_empty() {
            limit
        } else {
            usize::MAX
        };
        let mut stored = Vec::new();
        for (key, value) in self.db.iter(self.options()).from(&start) {
            if stored.len() >= stored_limit || key.0 >= end {
                break;
            }
            stored.push((Key::try_from(&key.0[prefix.len()..])?, value));
        }
        self.buffer.overlay(stored, from, to, limit, visit)
    }
    fn put(&mut self, key: Key, value: &[u8]) -> Result<()> {
        self.buffer.put(key, value);
        Ok(())
    }
    fn delete(&mut self, key: Key) -> Result<()> {
        self.buffer.delete(key);
        Ok(())
    }
}
impl Session for LevelDb {
    fn cleanup(&mut self, prefix: &str) -> Result<()> {
        let db = &self.0.db;
        for (from, to) in kv::cleanup_ranges(prefix) {
            let (from, to) = (Bytes(from), Bytes(to));
            let mut batch = Writebatch::new();
            for key in db.keys_iter(ReadOptions::new()).from(&from) {
                if key.0 >= to.0 {
                    break;
                }
                batch.delete(key);
            }
            db.write(WriteOptions::new(), &batch)?;
            // Like CHECKPOINT on the SQL engines: settle tombstones outside the timer.
            db.compact(&from, &to);
        }
        Ok(())
    }
    fn transact(&mut self, doc: &str, write: bool, work: &mut Work<'_>) -> Result<Output> {
        let db = &self.0.db;
        let tx = |snapshot| {
            kv::Tx(Tx {
                db,
                snapshot,
                doc,
                buffer: kv::Buffer::default(),
            })
        };
        if !write {
            return work(&mut tx(Some(db.snapshot())));
        }
        let _document = self.0.locks.lock(doc);
        let mut tx = tx(None);
        let result = work(&mut tx)?;
        let kv::Buffer { pending, vector } = tx.0.buffer;
        if pending.is_empty() && vector.is_none() {
            return Ok(result);
        }
        let prefix = kv::segment_prefix(doc);
        let mut batch = Writebatch::new();
        for (key, (_, value)) in pending {
            let key = Bytes([&prefix[..], &key].concat());
            match value {
                Some(value) => batch.put(key, &value),
                None => batch.delete(key),
            }
        }
        if let Some(vector) = vector {
            batch.put(Bytes(kv::vector_key(doc)), &vector);
        }
        let mut options = WriteOptions::new();
        options.sync = self.1;
        db.write(options, &batch)?;
        Ok(result)
    }
}
