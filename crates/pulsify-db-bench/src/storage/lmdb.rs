use super::kv::{self, Key, Kv};
use super::{Output, Session, Work};
use anyhow::Result;
use heed::types::Bytes;
use heed::{Database, EnvFlags, EnvOpenOptions, RoTxn, RwTxn, WithoutTls};
use std::ops::Bound::{Excluded, Included};

type Table = Database<Bytes, Bytes>;
type Env = heed::Env<WithoutTls>;
/// One process-wide environment; LMDB itself admits a single writer at a time.
#[derive(Clone)]
pub struct Lmdb(pub Env, pub Table);
pub fn open(path: &str, relaxed: bool) -> Result<Lmdb> {
    std::fs::create_dir_all(path)?;
    let mut options = EnvOpenOptions::new().read_txn_without_tls();
    options.map_size(8 << 30).max_readers(512);
    // Safety: this process opens the environment once, and NO_SYNC only trades
    // the last commits for speed on a system crash (no writable map is used).
    let env = unsafe {
        if relaxed {
            options.flags(EnvFlags::NO_SYNC);
        }
        options.open(path)?
    };
    let mut tx = env.write_txn()?;
    let table = env.create_database(&mut tx, None)?;
    tx.commit()?;
    Ok(Lmdb(env, table))
}

enum Access<'a> {
    Write(RwTxn<'a>),
    Read(RoTxn<'a, WithoutTls>),
}
struct Tx<'a> {
    access: Access<'a>,
    table: Table,
    doc: &'a str,
}
impl<'a> Tx<'a> {
    fn reader(&self) -> &RoTxn<'a, WithoutTls> {
        match &self.access {
            Access::Write(tx) => tx,
            Access::Read(tx) => tx,
        }
    }
    fn writer(&mut self) -> Result<&mut RwTxn<'a>> {
        match &mut self.access {
            Access::Write(tx) => Ok(tx),
            Access::Read(_) => anyhow::bail!("write in a read-only transaction"),
        }
    }
}
impl Kv for Tx<'_> {
    fn vector(&mut self) -> Result<Option<Vec<u8>>> {
        Ok(self
            .table
            .get(self.reader(), &kv::vector_key(self.doc))?
            .map(<[u8]>::to_vec))
    }
    fn set_vector(&mut self, value: &[u8]) -> Result<()> {
        let (table, key) = (self.table, kv::vector_key(self.doc));
        Ok(table.put(self.writer()?, &key, value)?)
    }
    fn scan(&mut self, from: Key, to: Key, limit: usize, visit: &mut kv::Visit<'_>) -> Result<()> {
        let prefix = kv::segment_prefix(self.doc);
        let (from, to) = ([&prefix[..], &from].concat(), [&prefix[..], &to].concat());
        let range = (Included(&from[..]), Excluded(&to[..]));
        for entry in self.table.range(self.reader(), &range)?.take(limit) {
            let (key, value) = entry?;
            visit(&key[prefix.len()..], value)?;
        }
        Ok(())
    }
    fn put(&mut self, key: Key, value: &[u8]) -> Result<()> {
        let (table, key) = (
            self.table,
            [&kv::segment_prefix(self.doc)[..], &key].concat(),
        );
        Ok(table.put(self.writer()?, &key, value)?)
    }
    fn delete(&mut self, key: Key) -> Result<()> {
        let (table, key) = (
            self.table,
            [&kv::segment_prefix(self.doc)[..], &key].concat(),
        );
        table.delete(self.writer()?, &key)?;
        Ok(())
    }
}
impl Session for Lmdb {
    fn cleanup(&mut self, prefix: &str) -> Result<()> {
        let mut tx = self.0.write_txn()?;
        for (from, to) in kv::cleanup_ranges(prefix) {
            let range = (Included(&from[..]), Excluded(&to[..]));
            self.1.delete_range(&mut tx, &range)?;
        }
        Ok(tx.commit()?)
    }
    fn transact(&mut self, doc: &str, write: bool, work: &mut Work<'_>) -> Result<Output> {
        let access = if write {
            Access::Write(self.0.write_txn()?)
        } else {
            Access::Read(self.0.read_txn()?)
        };
        let mut tx = kv::Tx(Tx {
            access,
            table: self.1,
            doc,
        });
        let result = work(&mut tx)?;
        if let Access::Write(tx) = tx.0.access {
            tx.commit()?;
        }
        Ok(result)
    }
}
