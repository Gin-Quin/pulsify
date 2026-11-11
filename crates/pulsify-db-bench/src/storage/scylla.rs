//! ScyllaDB: one partition per document, the ordered key-value layout of `kv.rs`
//! as its clustering key, and the frontier in static columns.
//!
//! There are no interactive transactions. A writer reads the document's version,
//! buffers its writes and sends them as one conditional batch on that partition
//! (a lightweight transaction): it applies only if the version is unchanged, and
//! the writer otherwise starts over. A reader pins the frontier first; segment
//! queries that follow can only be newer, which a delta may be.
use super::kv::{self, Key, Kv};
use super::{runtime, Output, Session, Work};
use crate::model::Segment;
use anyhow::{ensure, Context, Result};
use pulsify_protocol::VersionVector;
use scylla::client::session::Session as Client;
use scylla::client::session_builder::SessionBuilder;
use scylla::client::PoolSize;
use scylla::statement::batch::{Batch, BatchType};
use scylla::statement::prepared::PreparedStatement;
use scylla::value::{CqlValue, Row};
use std::num::NonZeroUsize;
use std::time::{Duration, Instant};

type Head = (Option<Vec<u8>>, Option<i64>);
pub struct Scylla {
    client: Client,
    head: PreparedStatement,
    scan: PreparedStatement,
    put: PreparedStatement,
    delete: PreparedStatement,
    version: PreparedStatement,
    frontier: PreparedStatement,
}
impl Scylla {
    pub fn initialize(node: &str) -> Result<()> {
        runtime().block_on(async {
            let client = SessionBuilder::new().known_node(node).build().await?;
            // Lightweight transactions need vnodes on current releases.
            client.query_unpaged("CREATE KEYSPACE IF NOT EXISTS pulsify WITH replication = {'class': 'NetworkTopologyStrategy', 'replication_factor': 1} AND tablets = {'enabled': false}", ()).await?;
            client.query_unpaged("CREATE TABLE IF NOT EXISTS pulsify.segments (doc text, k blob, v blob, vector blob static, version bigint static, PRIMARY KEY (doc, k))", ()).await?;
            Ok(())
        })
    }
    pub fn open(node: &str) -> Result<Self> {
        runtime().block_on(async {
            let client = SessionBuilder::new()
                .known_node(node)
                .pool_size(PoolSize::PerShard(NonZeroUsize::MIN))
                .build()
                .await?;
            let prepare = |cql: &'static str| client.prepare(cql);
            Ok(Self {
                head: prepare("SELECT vector, version FROM pulsify.segments WHERE doc = ? LIMIT 1").await?,
                scan: prepare("SELECT k, v FROM pulsify.segments WHERE doc = ? AND k >= ? AND k < ? LIMIT ?").await?,
                put: prepare("INSERT INTO pulsify.segments (doc, k, v) VALUES (?, ?, ?)").await?,
                delete: prepare("DELETE FROM pulsify.segments WHERE doc = ? AND k = ?").await?,
                version: prepare("UPDATE pulsify.segments SET version = ? WHERE doc = ? IF version = ?").await?,
                frontier: prepare("UPDATE pulsify.segments SET version = ?, vector = ? WHERE doc = ? IF version = ?").await?,
                client,
            })
        })
    }
    pub fn metadata(&self, relaxed: bool) -> Result<serde_json::Value> {
        runtime().block_on(async {
            let text = |cql: &'static str| async move {
                let rows = self
                    .client
                    .query_unpaged(cql, ())
                    .await?
                    .into_rows_result()?;
                anyhow::Ok(rows.maybe_first_row::<(String,)>()?.map(|row| row.0))
            };
            let sync =
                text("SELECT value FROM system.config WHERE name = 'commitlog_sync'").await?;
            // The setting is stored as a JSON string.
            let sync = sync.map(|value| value.trim_matches('"').to_owned());
            ensure!(
                sync.as_deref() == Some(if relaxed { "periodic" } else { "batch" }),
                "ScyllaDB commitlog_sync {sync:?} does not match the durability tier"
            );
            Ok(serde_json::json!({
                "version": text("SELECT version FROM system.versions").await.ok().flatten(),
                "settings": {"commitlog_sync": sync},
                "concurrency": "optimistic: conditional batch on the document version",
            }))
        })
    }
    fn head(&self, doc: &str) -> Result<Head> {
        runtime().block_on(async {
            let rows = self.client.execute_unpaged(&self.head, (doc,)).await?;
            Ok(rows
                .into_rows_result()?
                .maybe_first_row::<Head>()?
                .unwrap_or_default())
        })
    }
    /// Apply one transaction's writes if nobody changed the document meanwhile.
    fn commit(&self, doc: &str, version: Option<i64>, buffer: kv::Buffer) -> Result<bool> {
        let mut batch = Batch::new(BatchType::Logged);
        let mut values: Vec<Vec<Option<CqlValue>>> = Vec::new();
        let text = || Some(CqlValue::Text(doc.to_owned()));
        for (key, (replace, value)) in buffer.pending {
            // An insert overwrites the row, so only a pure removal needs a delete.
            match value {
                Some(value) => {
                    batch.append_statement(self.put.clone());
                    values.push(vec![
                        text(),
                        Some(CqlValue::Blob(key.to_vec())),
                        Some(CqlValue::Blob(value)),
                    ]);
                }
                None if replace => {
                    batch.append_statement(self.delete.clone());
                    values.push(vec![text(), Some(CqlValue::Blob(key.to_vec()))]);
                }
                None => {}
            }
        }
        let next = Some(CqlValue::BigInt(version.unwrap_or(0) + 1));
        let expected = version.map(CqlValue::BigInt);
        match buffer.vector {
            Some(vector) => {
                batch.append_statement(self.frontier.clone());
                values.push(vec![next, Some(CqlValue::Blob(vector)), text(), expected]);
            }
            None => {
                batch.append_statement(self.version.clone());
                values.push(vec![next, text(), expected]);
            }
        }
        runtime().block_on(async {
            let rows = self
                .client
                .batch(&batch, values)
                .await?
                .into_rows_result()?;
            let row = rows.first_row::<Row>()?;
            match row.columns.first() {
                Some(Some(CqlValue::Boolean(applied))) => Ok(*applied),
                other => anyhow::bail!("unexpected conditional batch reply: {other:?}"),
            }
        })
    }
}

struct Tx<'a> {
    session: &'a Scylla,
    doc: &'a str,
    buffer: kv::Buffer,
    head: Option<Head>,
}
impl Kv for Tx<'_> {
    fn vector(&mut self) -> Result<Option<Vec<u8>>> {
        if self.head.is_none() {
            self.head = Some(self.session.head(self.doc)?);
        }
        Ok(self.head.as_ref().and_then(|head| head.0.clone()))
    }
    fn set_vector(&mut self, value: &[u8]) -> Result<()> {
        self.buffer.vector = Some(value.to_vec());
        Ok(())
    }
    fn scan(&mut self, from: Key, to: Key, limit: usize, visit: &mut kv::Visit<'_>) -> Result<()> {
        // Buffered writes can hide or add entries, so only an empty buffer may limit.
        let stored_limit = if self.buffer.pending.is_empty() {
            limit.min(i32::MAX as usize) as i32
        } else {
            i32::MAX
        };
        let session = self.session;
        let stored = runtime().block_on(async {
            let rows = session
                .client
                .execute_unpaged(&session.scan, (self.doc, &from[..], &to[..], stored_limit))
                .await?
                .into_rows_result()?;
            let mut entries = Vec::new();
            for row in rows.rows::<(Vec<u8>, Vec<u8>)>()? {
                let (key, value) = row?;
                entries.push((Key::try_from(&key[..]).context("clustering key")?, value));
            }
            anyhow::Ok(entries)
        })?;
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
        self.vector()?;
        Ok(None)
    }
}
impl Session for Scylla {
    fn cleanup(&mut self, prefix: &str) -> Result<()> {
        // Partition keys are hashed: list them, then drop the matching documents.
        runtime().block_on(async {
            let rows = self
                .client
                .query_unpaged("SELECT DISTINCT doc FROM pulsify.segments", ())
                .await?
                .into_rows_result()?;
            for row in rows.rows::<(String,)>()? {
                let doc = row?.0;
                if doc.starts_with(prefix) {
                    self.client
                        .query_unpaged("DELETE FROM pulsify.segments WHERE doc = ?", (doc,))
                        .await?;
                }
            }
            Ok(())
        })
    }
    fn transact(&mut self, doc: &str, write: bool, work: &mut Work<'_>) -> Result<Output> {
        let tx = |head| {
            kv::Tx(Tx {
                session: self,
                doc,
                buffer: kv::Buffer::default(),
                head,
            })
        };
        if !write {
            return work(&mut tx(None));
        }
        let started = Instant::now();
        let mut retries = 0u64;
        loop {
            let head = self.head(doc)?;
            let mut tx = tx(Some(head.clone()));
            let result = work(&mut tx);
            let buffer = tx.0.buffer;
            let settled = match &result {
                Ok(_) if buffer.is_empty() => true,
                Ok(_) => self.commit(doc, head.1, buffer)?,
                // A failure seen under an unchanged version is real; otherwise the
                // transaction read a document someone else was changing.
                Err(_) => self.head(doc)?.1 == head.1,
            };
            if settled {
                return result.map(|mut output| {
                    output.retries += retries;
                    output
                });
            }
            retries += 1;
            ensure!(
                started.elapsed() < Duration::from_secs(30),
                "optimistic write deadline"
            );
            // Jittered, growing pause: losers of one round should not collide again.
            let ceiling = 200u64 << retries.min(6);
            let jitter = started.elapsed().subsec_nanos() as u64 % ceiling;
            std::thread::sleep(Duration::from_micros(ceiling / 2 + jitter));
        }
    }
}
