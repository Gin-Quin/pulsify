use super::{Output, Session, Transaction, Work};
use crate::model::Segment;
use anyhow::{ensure, Result};
use pulsify_protocol::VersionVector;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::cell::Cell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

// SQLite still owns write admission. Short, jittered sleeps avoid synchronized
// 100 ms wakeups when many independent connections contend for short writes.
static NEXT_BUSY_SEED: AtomicU64 = AtomicU64::new(1);
thread_local! {
    static BUSY_STATE: Cell<(Instant, u64)> = Cell::new((Instant::now(), NEXT_BUSY_SEED.fetch_add(1, Ordering::Relaxed)));
}
fn busy(attempt: i32) -> bool {
    BUSY_STATE.with(|state| {
        let (started, seed) = state.get();
        let started = if attempt == 0 {
            Instant::now()
        } else {
            started
        };
        let seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        state.set((started, seed));
        let Some(remaining) = Duration::from_secs(30).checked_sub(started.elapsed()) else {
            return false;
        };
        std::thread::sleep(Duration::from_micros(100 + (seed >> 32) % 900).min(remaining));
        started.elapsed() < Duration::from_secs(30)
    })
}

pub struct Sqlite(pub Connection);
impl Sqlite {
    pub fn open(path: &str) -> Result<Self> {
        Self::open_with(path, "jitter", 64 * 1024 * 1024)
    }
    pub fn open_with(path: &str, busy_mode: &str, mmap_bytes: u64) -> Result<Self> {
        ensure!(mmap_bytes <= 1024 * 1024 * 1024, "mmap limit is 1 GiB");
        let db = Connection::open(path)?;
        match busy_mode {
            "jitter" => db.busy_handler(Some(busy))?,
            "timeout" => db.busy_timeout(Duration::from_secs(30))?,
            _ => anyhow::bail!("unknown SQLite busy mode"),
        }
        db.execute_batch("PRAGMA synchronous=FULL;")?;
        db.pragma_update(None, "mmap_size", mmap_bytes as i64)?;
        Ok(Self(db))
    }
    pub fn metadata(&self, busy_mode: &str) -> Result<serde_json::Value> {
        let mut settings = serde_json::Map::new();
        for name in [
            "journal_mode",
            "synchronous",
            "mmap_size",
            "cache_size",
            "page_size",
            "wal_autocheckpoint",
        ] {
            let value = self.0.query_row(&format!("PRAGMA {name}"), [], |r| {
                Ok(match r.get_ref(0)? {
                    rusqlite::types::ValueRef::Integer(n) => n.to_string(),
                    rusqlite::types::ValueRef::Text(v) => String::from_utf8_lossy(v).into_owned(),
                    _ => unreachable!("unexpected PRAGMA type"),
                })
            })?;
            settings.insert(name.into(), value.into());
        }
        ensure!(
            settings["journal_mode"] == "wal" && settings["synchronous"] == "2",
            "Durable WAL/FULL settings required"
        );
        Ok(
            serde_json::json!({"sqliteVersion":rusqlite::version(),"settings":settings,"busyMode":busy_mode,"busyDeadlineMs":30000}),
        )
    }
    pub fn initialize(path: &str) -> Result<()> {
        let db = Self::open(path)?;
        db.0.execute_batch("PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS native_segments(doc TEXT NOT NULL,sid INTEGER NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,metadata TEXT NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(doc,sid,start)) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS native_end ON native_segments(doc,sid,end);
        CREATE TABLE IF NOT EXISTS native_vectors(doc TEXT PRIMARY KEY,vector TEXT NOT NULL) WITHOUT ROWID;")?;
        Ok(())
    }
}
struct Tx<'a> {
    tx: rusqlite::Transaction<'a>,
    doc: &'a str,
}
fn unpack(row: &rusqlite::Row<'_>) -> rusqlite::Result<Segment> {
    let metadata: String = row.get(0)?;
    let mut s: Segment = serde_json::from_str(&metadata).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    s.payload = row.get(1)?;
    Ok(s)
}
impl Transaction for Tx<'_> {
    fn vector(&mut self) -> Result<VersionVector> {
        let value: Option<String> = self
            .tx
            .prepare_cached("SELECT vector FROM native_vectors WHERE doc=?")?
            .query_row([self.doc], |r| r.get(0))
            .optional()?;
        Ok(value
            .map(|v| serde_json::from_str(&v))
            .transpose()?
            .unwrap_or_default())
    }
    fn set_vector(&mut self, vv: &VersionVector) -> Result<()> {
        self.tx.prepare_cached("INSERT INTO native_vectors VALUES(?,?) ON CONFLICT(doc) DO UPDATE SET vector=excluded.vector")?.execute(params![self.doc,serde_json::to_string(vv)?])?;
        Ok(())
    }
    fn get(&mut self, sid: u64, start: u64) -> Result<Option<Segment>> {
        Ok(self
            .tx
            .prepare_cached(
                "SELECT metadata,payload FROM native_segments WHERE doc=? AND sid=? AND start=?",
            )?
            .query_row(params![self.doc, sid as i64, start as i64], unpack)
            .optional()?)
    }
    fn read(&mut self, remote: &VersionVector) -> Result<Vec<Segment>> {
        if remote.is_empty() {
            let mut q = self.tx.prepare_cached(
                "SELECT metadata,payload FROM native_segments WHERE doc=? ORDER BY sid,start",
            )?;
            return Ok(q
                .query_map([self.doc], unpack)?
                .collect::<rusqlite::Result<Vec<_>>>()?);
        }
        let mut q = self.tx.prepare_cached("WITH remote(sid,clock) AS MATERIALIZED (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?)) SELECT s.metadata,s.payload FROM native_segments s LEFT JOIN remote r ON r.sid=s.sid WHERE s.doc=? AND s.end>coalesce(r.clock,0) ORDER BY s.sid,s.start")?;
        let rows = q
            .query_map(params![serde_json::to_string(remote)?, self.doc], unpack)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
    fn put(&mut self, s: &Segment) -> Result<()> {
        let mut metadata = s.clone();
        metadata.payload.clear();
        self.tx
            .prepare_cached("INSERT INTO native_segments VALUES(?,?,?,?,?,?)")?
            .execute(params![
                self.doc,
                s.sid as i64,
                s.start as i64,
                s.end as i64,
                serde_json::to_string(&metadata)?,
                s.payload
            ])?;
        Ok(())
    }
    fn matches(&mut self, sources: &[Segment]) -> Result<bool> {
        let first = &sources[0];
        let last = sources.last().unwrap();
        let mut q = self.tx.prepare_cached("SELECT metadata,payload FROM native_segments WHERE doc=? AND sid=? AND start BETWEEN ? AND ? ORDER BY start")?;
        let actual = q
            .query_map(
                params![
                    self.doc,
                    first.sid as i64,
                    first.start as i64,
                    last.start as i64
                ],
                unpack,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(actual == sources)
    }
    fn remove(&mut self, sources: &[Segment]) -> Result<()> {
        let first = &sources[0];
        let last = sources.last().unwrap();
        let removed = self
            .tx
            .prepare_cached(
                "DELETE FROM native_segments WHERE doc=? AND sid=? AND start BETWEEN ? AND ?",
            )?
            .execute(params![
                self.doc,
                first.sid as i64,
                first.start as i64,
                last.start as i64
            ])?;
        ensure!(removed == sources.len(), "compaction delete count");
        Ok(())
    }
}
impl Session for Sqlite {
    fn cleanup(&mut self, prefix: &str) -> Result<()> {
        let upper = format!("{prefix}~");
        self.0.execute(
            "DELETE FROM native_segments WHERE doc >= ? AND doc < ?",
            params![prefix, upper],
        )?;
        self.0.execute(
            "DELETE FROM native_vectors WHERE doc >= ? AND doc < ?",
            params![prefix, upper],
        )?;
        Ok(())
    }
    fn transact(&mut self, doc: &str, write: bool, work: &mut Work<'_>) -> Result<Output> {
        let tx = self.0.transaction_with_behavior(if write {
            TransactionBehavior::Immediate
        } else {
            TransactionBehavior::Deferred
        })?;
        let mut tx = Tx { tx, doc };
        let result = work(&mut tx)?;
        tx.tx.commit()?;
        Ok(result)
    }
}
