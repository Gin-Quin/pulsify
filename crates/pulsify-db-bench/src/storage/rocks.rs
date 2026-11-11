use super::kv::{self, Key, Kv};
use super::{Output, Session, Work};
use anyhow::Result;
use rocksdb::{
    DBAccess, DBRawIteratorWithThreadMode, Options, ReadOptions, SnapshotWithThreadMode,
    TransactionDB, TransactionDBOptions, TransactionOptions, WriteBatch, WriteOptions, DB,
};
use std::sync::Arc;

/// One process-wide database; every worker gets its own handle and transactions.
pub struct Rocks(pub Arc<TransactionDB>, pub bool);
pub fn open(path: &str) -> Result<Arc<TransactionDB>> {
    let mut options = Options::default();
    options.create_if_missing(true);
    let mut locks = TransactionDBOptions::default();
    locks.set_default_lock_timeout(30_000);
    locks.set_txn_lock_timeout(30_000);
    Ok(Arc::new(TransactionDB::open(&options, &locks, path)?))
}

enum Access<'a> {
    Write(rocksdb::Transaction<'a, TransactionDB>),
    Read(SnapshotWithThreadMode<'a, TransactionDB>),
}
struct Tx<'a> {
    access: Access<'a>,
    doc: &'a str,
}
fn walk<D: DBAccess>(
    mut cursor: DBRawIteratorWithThreadMode<'_, D>,
    from: &[u8],
    strip: usize,
    limit: usize,
    visit: &mut kv::Visit<'_>,
) -> Result<()> {
    cursor.seek(from);
    let mut seen = 0;
    while seen < limit && cursor.valid() {
        visit(&cursor.key().unwrap()[strip..], cursor.value().unwrap())?;
        seen += 1;
        cursor.next();
    }
    Ok(cursor.status()?)
}
impl Kv for Tx<'_> {
    fn vector(&mut self) -> Result<Option<Vec<u8>>> {
        let key = kv::vector_key(self.doc);
        Ok(match &self.access {
            Access::Write(tx) => tx.get(key)?,
            Access::Read(snapshot) => snapshot.get(key)?,
        })
    }
    fn set_vector(&mut self, value: &[u8]) -> Result<()> {
        self.write()?.put(kv::vector_key(self.doc), value)?;
        Ok(())
    }
    fn scan(&mut self, from: Key, to: Key, limit: usize, visit: &mut kv::Visit<'_>) -> Result<()> {
        let prefix = kv::segment_prefix(self.doc);
        let mut options = ReadOptions::default();
        options.set_iterate_upper_bound([&prefix[..], &to].concat());
        let from = [&prefix[..], &from].concat();
        match &self.access {
            Access::Write(tx) => walk(
                tx.raw_iterator_opt(options),
                &from,
                prefix.len(),
                limit,
                visit,
            ),
            Access::Read(snapshot) => walk(
                snapshot.raw_iterator_opt(options),
                &from,
                prefix.len(),
                limit,
                visit,
            ),
        }
    }
    fn put(&mut self, key: Key, value: &[u8]) -> Result<()> {
        self.write()?
            .put([&kv::segment_prefix(self.doc)[..], &key].concat(), value)?;
        Ok(())
    }
    fn delete(&mut self, key: Key) -> Result<()> {
        self.write()?
            .delete([&kv::segment_prefix(self.doc)[..], &key].concat())?;
        Ok(())
    }
}
impl Tx<'_> {
    fn write(&self) -> Result<&rocksdb::Transaction<'_, TransactionDB>> {
        match &self.access {
            Access::Write(tx) => Ok(tx),
            Access::Read(_) => anyhow::bail!("write in a read-only transaction"),
        }
    }
}
impl Session for Rocks {
    fn cleanup(&mut self, prefix: &str) -> Result<()> {
        for (from, to) in kv::cleanup_ranges(prefix) {
            let mut options = ReadOptions::default();
            options.set_iterate_upper_bound(to);
            let mut cursor = self.0.raw_iterator_opt(options);
            cursor.seek(&from);
            while cursor.valid() {
                self.0.delete(cursor.key().unwrap())?;
                cursor.next();
            }
            cursor.status()?;
        }
        // Like CHECKPOINT on the SQL engines: persist the memtable outside the timer.
        self.0.flush()?;
        Ok(())
    }
    fn transact(&mut self, doc: &str, write: bool, work: &mut Work<'_>) -> Result<Output> {
        if !write {
            let access = Access::Read(self.0.snapshot());
            return work(&mut kv::Tx(Tx { access, doc }));
        }
        let mut options = WriteOptions::default();
        options.set_sync(self.1);
        let tx = self
            .0
            .transaction_opt(&options, &TransactionOptions::default());
        // The database's own row lock on the frontier serializes one document's
        // writers until commit; writers of other documents commit in WAL groups.
        tx.get_for_update(kv::vector_key(doc), true)?;
        let mut tx = kv::Tx(Tx {
            access: Access::Write(tx),
            doc,
        });
        let result = work(&mut tx)?;
        if let Access::Write(tx) = tx.0.access {
            tx.commit()?;
        }
        Ok(result)
    }
}

/// The same engine without `TransactionDB`: a plain database, a striped mutex in
/// this process as the document lock, and one write batch per transaction. It
/// measures what the transaction layer costs.
pub struct Plain {
    db: DB,
    locks: kv::Locks,
}
pub struct RocksMutex(pub Arc<Plain>, pub bool);
pub fn open_plain(path: &str) -> Result<Arc<Plain>> {
    let mut options = Options::default();
    options.create_if_missing(true);
    Ok(Arc::new(Plain {
        db: DB::open(&options, path)?,
        locks: kv::Locks::default(),
    }))
}
struct PlainTx<'a> {
    db: &'a DB,
    snapshot: Option<SnapshotWithThreadMode<'a, DB>>,
    doc: &'a str,
    buffer: kv::Buffer,
}
impl Kv for PlainTx<'_> {
    fn vector(&mut self) -> Result<Option<Vec<u8>>> {
        let key = kv::vector_key(self.doc);
        Ok(match &self.snapshot {
            Some(snapshot) => snapshot.get(key)?,
            None => self.db.get(key)?,
        })
    }
    fn set_vector(&mut self, value: &[u8]) -> Result<()> {
        self.buffer.vector = Some(value.to_vec());
        Ok(())
    }
    fn scan(&mut self, from: Key, to: Key, limit: usize, visit: &mut kv::Visit<'_>) -> Result<()> {
        let prefix = kv::segment_prefix(self.doc);
        let mut options = ReadOptions::default();
        options.set_iterate_upper_bound([&prefix[..], &to].concat());
        let start = [&prefix[..], &from].concat();
        // Buffered writes can hide or add entries, so only an empty buffer may limit.
        let stored_limit = if self.buffer.pending.is_empty() {
            limit
        } else {
            usize::MAX
        };
        let mut stored = Vec::new();
        let mut collect = |key: &[u8], value: &[u8]| {
            stored.push((Key::try_from(key)?, value.to_vec()));
            Ok(())
        };
        match &self.snapshot {
            Some(snapshot) => walk(
                snapshot.raw_iterator_opt(options),
                &start,
                prefix.len(),
                stored_limit,
                &mut collect,
            ),
            None => walk(
                self.db.raw_iterator_opt(options),
                &start,
                prefix.len(),
                stored_limit,
                &mut collect,
            ),
        }?;
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
impl Session for RocksMutex {
    fn cleanup(&mut self, prefix: &str) -> Result<()> {
        let db = &self.0.db;
        for (from, to) in kv::cleanup_ranges(prefix) {
            let mut batch = WriteBatch::default();
            batch.delete_range(from, to);
            db.write(batch)?;
        }
        // Like CHECKPOINT on the SQL engines: persist the memtable outside the timer.
        Ok(db.flush()?)
    }
    fn transact(&mut self, doc: &str, write: bool, work: &mut Work<'_>) -> Result<Output> {
        let db = &self.0.db;
        let tx = |snapshot| {
            kv::Tx(PlainTx {
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
        let mut batch = WriteBatch::default();
        for (key, (_, value)) in pending {
            let key = [&prefix[..], &key].concat();
            match value {
                Some(value) => batch.put(key, value),
                None => batch.delete(key),
            }
        }
        if let Some(vector) = vector {
            batch.put(kv::vector_key(doc), vector);
        }
        let mut options = WriteOptions::default();
        options.set_sync(self.1);
        db.write_opt(batch, &options)?;
        Ok(result)
    }
}
