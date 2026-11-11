//! ClickHouse, for curiosity: an analytical engine asked to do transactional work.
//!
//! It has neither row locks nor multi-statement transactions. The document lock
//! is a row in a KeeperMap table that only one inserter can create. One
//! transaction's writes are a single INSERT, which is atomic, into a
//! ReplacingMergeTree keyed like `kv.rs`: a newer row replaces an older one and a
//! `deleted` row hides it. Readers pin the frontier first; segment queries that
//! follow can only be newer, which a delta may be.
use super::kv::{self, Key, Kv};
use super::{runtime, Output, Session, Work};
use crate::model::Segment;
use anyhow::{ensure, Context, Result};
use clickhouse::{Client, Row};
use pulsify_protocol::VersionVector;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

#[derive(Row, Serialize)]
struct Entry<'a> {
    doc: &'a str,
    #[serde(with = "serde_bytes")]
    k: Vec<u8>,
    #[serde(with = "serde_bytes")]
    v: Vec<u8>,
    deleted: u8,
}
#[derive(Row, Deserialize)]
struct Pair {
    #[serde(with = "serde_bytes")]
    k: Vec<u8>,
    #[serde(with = "serde_bytes")]
    v: Vec<u8>,
}
const LIVE: &str = "SELECT k, v FROM pulsify.segments FINAL WHERE doc = ? AND deleted = 0";
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub struct ClickHouse(Client, u64);
impl ClickHouse {
    pub fn open(url: &str) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let client = Client::default()
            .with_url(url)
            .with_user("default")
            .with_password("pulsify-benchmark");
        Self(client, NEXT.fetch_add(1, Ordering::Relaxed))
    }
    pub fn initialize(url: &str, relaxed: bool) -> Result<()> {
        let client = Self::open(url).0;
        let sync = u8::from(!relaxed);
        runtime().block_on(async {
            for statement in [
                "CREATE DATABASE IF NOT EXISTS pulsify".to_owned(),
                "CREATE TABLE IF NOT EXISTS pulsify.locks (doc String, owner UInt64) ENGINE = KeeperMap('/pulsify_locks') PRIMARY KEY doc".to_owned(),
                format!("CREATE TABLE IF NOT EXISTS pulsify.segments (doc String, k String, v String, deleted UInt8, ver DateTime64(9) DEFAULT now64(9)) ENGINE = ReplacingMergeTree(ver) ORDER BY (doc, k) SETTINGS fsync_after_insert = {sync}, fsync_part_directory = {sync}"),
            ] {
                client.query(&statement).execute().await?;
            }
            Ok(())
        })
    }
    pub fn metadata(&self, relaxed: bool) -> Result<serde_json::Value> {
        runtime().block_on(async {
            let version: String = self.0.query("SELECT version()").fetch_one().await?;
            let table: String = self
                .0
                .query("SELECT create_table_query FROM system.tables WHERE database = 'pulsify' AND name = 'segments'")
                .fetch_one()
                .await?;
            let sync = u8::from(!relaxed);
            ensure!(
                table.contains(&format!("fsync_after_insert = {sync}")),
                "ClickHouse table settings do not match the durability tier"
            );
            Ok(serde_json::json!({
                "version": version,
                "table": table,
                "concurrency": "KeeperMap document lock; one atomic INSERT per transaction",
            }))
        })
    }
}

struct Tx<'a> {
    client: &'a Client,
    doc: &'a str,
    buffer: kv::Buffer,
    frontier: Option<Option<Vec<u8>>>,
}
impl Kv for Tx<'_> {
    fn vector(&mut self) -> Result<Option<Vec<u8>>> {
        if let Some(frontier) = &self.frontier {
            return Ok(frontier.clone());
        }
        let query = self
            .client
            .query(&format!("{LIVE} AND k = ''"))
            .bind(self.doc);
        let row = runtime().block_on(query.fetch_optional::<Pair>())?;
        Ok(row.map(|pair| pair.v))
    }
    fn set_vector(&mut self, value: &[u8]) -> Result<()> {
        self.buffer.vector = Some(value.to_vec());
        Ok(())
    }
    fn scan(&mut self, from: Key, to: Key, limit: usize, visit: &mut kv::Visit<'_>) -> Result<()> {
        // Buffered writes can hide or add entries, so only an empty buffer may limit.
        let stored_limit = if self.buffer.pending.is_empty() {
            limit as u64
        } else {
            u64::MAX
        };
        let query = self
            .client
            .query(&format!(
                "{LIVE} AND k >= unhex(?) AND k < unhex(?) ORDER BY k LIMIT ?"
            ))
            .bind(self.doc)
            .bind(hex(&from))
            .bind(hex(&to))
            .bind(stored_limit);
        let mut stored = Vec::new();
        for pair in runtime().block_on(query.fetch_all::<Pair>())? {
            stored.push((Key::try_from(&pair.k[..]).context("segment key")?, pair.v));
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
    fn read(&mut self, _remote: &VersionVector) -> Result<Option<Vec<Segment>>> {
        self.frontier = Some(self.vector()?);
        Ok(None)
    }
}
impl ClickHouse {
    /// Only one inserter can create the document's row in strict mode.
    fn lock(&self, doc: &str) -> Result<()> {
        let started = Instant::now();
        for attempt in 0u32.. {
            let insert = self
                .0
                .query("INSERT INTO pulsify.locks VALUES (?, ?)")
                .with_setting("keeper_map_strict_mode", "1")
                .bind(doc)
                .bind(self.1);
            match runtime().block_on(insert.execute()) {
                Ok(()) => return Ok(()),
                Err(error) if error.to_string().contains("Node exists") => {}
                Err(error) => return Err(error.into()),
            }
            ensure!(
                started.elapsed() < Duration::from_secs(30),
                "document lock timeout"
            );
            let ceiling = 200u64 << attempt.min(5);
            let jitter = started.elapsed().subsec_nanos() as u64 % ceiling;
            std::thread::sleep(Duration::from_micros(ceiling / 2 + jitter));
        }
        unreachable!()
    }
    fn commit(&self, doc: &str, buffer: kv::Buffer) -> Result<()> {
        runtime().block_on(async {
            let mut insert = self.0.insert_unescaped::<Entry>("pulsify.segments").await?;
            for (key, (_, value)) in buffer.pending {
                let deleted = u8::from(value.is_none());
                let entry = Entry {
                    doc,
                    k: key.to_vec(),
                    v: value.unwrap_or_default(),
                    deleted,
                };
                insert.write(&entry).await?;
            }
            if let Some(vector) = buffer.vector {
                let entry = Entry {
                    doc,
                    k: vec![],
                    v: vector,
                    deleted: 0,
                };
                insert.write(&entry).await?;
            }
            Ok(insert.end().await?)
        })
    }
}
impl Session for ClickHouse {
    fn cleanup(&mut self, prefix: &str) -> Result<()> {
        runtime().block_on(async {
            for table in ["segments", "locks"] {
                self.0
                    .query(&format!(
                        "DELETE FROM pulsify.{table} WHERE startsWith(doc, ?)"
                    ))
                    .bind(prefix)
                    .execute()
                    .await?;
            }
            Ok(())
        })
    }
    fn transact(&mut self, doc: &str, write: bool, work: &mut Work<'_>) -> Result<Output> {
        if write {
            self.lock(doc)?;
        }
        let mut tx = kv::Tx(Tx {
            client: &self.0,
            doc,
            buffer: kv::Buffer::default(),
            frontier: None,
        });
        let result = work(&mut tx);
        if !write {
            return result;
        }
        let buffer = tx.0.buffer;
        let committed = match &result {
            Ok(_) if !buffer.is_empty() => self.commit(doc, buffer),
            _ => Ok(()),
        };
        let release = self
            .0
            .query("DELETE FROM pulsify.locks WHERE doc = ?")
            .bind(doc);
        runtime().block_on(release.execute())?;
        committed?;
        result
    }
}
