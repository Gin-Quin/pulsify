use super::{Output, Session, Transaction, Work};
use crate::model::Segment;
use anyhow::{ensure, Result};
use postgres::{Client, IsolationLevel, NoTls, Row};
use pulsify_protocol::VersionVector;

pub struct Pg(pub Client, bool);
impl Pg {
    #[cfg(test)]
    pub fn open(url: &str) -> Result<Self> {
        Self::open_for(url, "postgres")
    }
    pub fn open_for(url: &str, flavor: &str) -> Result<Self> {
        let mut client = Client::connect(url, NoTls)?;
        client.batch_execute("SET statement_timeout='30s'; SET lock_timeout='30s';")?;
        Ok(Self(client, flavor == "pgrust-columnar"))
    }
    #[cfg(test)]
    pub fn initialize(url: &str) -> Result<()> {
        Self::initialize_for(url, "postgres")
    }
    pub fn initialize_for(url: &str, flavor: &str) -> Result<()> {
        let mut pg = Self::open_for(url, flavor)?;
        let version: String = pg.0.query_one("SELECT version()", &[])?.get(0);
        if flavor.starts_with("pgrust-") {
            ensure!(
                version.contains("pgrust 0.4-beta"),
                "Expected pgrust 0.4-beta: {version}"
            );
        }
        let columnar = flavor == "pgrust-columnar";
        let am = match flavor {
            "orioledb" => {
                pg.0.batch_execute("CREATE EXTENSION IF NOT EXISTS orioledb")?;
                "orioledb"
            }
            "pgrust-columnar" => {
                if pg
                    .0
                    .query("SELECT amname FROM pg_am WHERE amname='pgrcolumnar'", &[])?
                    .is_empty()
                {
                    pg.0.batch_execute(
                        "CREATE ACCESS METHOD pgrcolumnar TYPE TABLE HANDLER heap_tableam_handler",
                    )?;
                }
                "pgrcolumnar"
            }
            _ => "heap",
        };
        // Columnar has no unique indexes in v0.4. The same document transaction lock
        // protects duplicate detection and vector replacement; correctness is checked
        // by the rollback/concurrency contract before each measured campaign.
        let segment_key = if columnar {
            ""
        } else {
            ",PRIMARY KEY(doc,sid,start)"
        };
        let vector_key = if columnar { "" } else { " PRIMARY KEY" };
        pg.0.batch_execute(&format!("CREATE TABLE IF NOT EXISTS native_segments(doc TEXT NOT NULL,sid BIGINT NOT NULL,start BIGINT NOT NULL,\"end\" BIGINT NOT NULL,metadata TEXT NOT NULL,payload BYTEA NOT NULL{segment_key}) USING {am};
        CREATE INDEX IF NOT EXISTS native_end ON native_segments(doc,sid,\"end\");
        CREATE TABLE IF NOT EXISTS native_vectors(doc TEXT{vector_key} NOT NULL,vector TEXT NOT NULL) USING {am};"))?;
        if columnar {
            pg.0.batch_execute(
                "CREATE INDEX IF NOT EXISTS native_start ON native_segments(doc,sid,start); CREATE INDEX IF NOT EXISTS native_vector_doc ON native_vectors(doc)",
            )?;
        }
        let actual = pg.0.query("SELECT c.relname,a.amname FROM pg_class c JOIN pg_am a ON a.oid=c.relam JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname IN ('native_segments','native_vectors') ORDER BY c.relname", &[])?;
        ensure!(
            actual.len() == 2 && actual.iter().all(|r| r.get::<_, &str>(1) == am),
            "Benchmark tables must both use {am}"
        );
        println!("Verified {flavor}: {version}; both tables USING {am}");
        Ok(())
    }
    pub fn metadata(&mut self) -> Result<serde_json::Value> {
        let version: String = self.0.query_one("SELECT version()", &[])?.get(0);
        let tables: Vec<serde_json::Value> = self.0.query("SELECT c.relname,a.amname FROM pg_class c JOIN pg_am a ON a.oid=c.relam WHERE c.relname IN ('native_segments','native_vectors') ORDER BY c.relname", &[])?.iter().map(|r| serde_json::json!({"table":r.get::<_, &str>(0), "accessMethod":r.get::<_, &str>(1)})).collect();
        let indexes: Vec<serde_json::Value> = self.0.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=current_schema() AND tablename IN ('native_segments','native_vectors') ORDER BY indexname", &[])?.iter().map(|r| serde_json::json!({"name":r.get::<_, &str>(0),"definition":r.get::<_, &str>(1)})).collect();
        if self.1 {
            ensure!(
                indexes.iter().any(|i| i["name"] == "native_start"),
                "Columnar point lookup index missing"
            );
        }
        let mut settings = serde_json::Map::new();
        for name in [
            "fsync",
            "synchronous_commit",
            "full_page_writes",
            "max_connections",
            "shared_buffers",
        ] {
            let value: String = self.0.query_one(&format!("SHOW {name}"), &[])?.get(0);
            settings.insert(name.into(), value.into());
        }
        ensure!(
            settings["fsync"] == "on" && settings["synchronous_commit"] == "on",
            "Durable settings required"
        );
        Ok(
            serde_json::json!({"version":version,"tables":tables,"indexes":indexes,"settings":settings,"columnarVectorReplacement":self.1}),
        )
    }
}
struct Tx<'a> {
    tx: postgres::Transaction<'a>,
    doc: &'a str,
    columnar: bool,
}
fn unpack(row: Row) -> Result<Segment> {
    let mut s: Segment = serde_json::from_str(row.get::<_, &str>(0))?;
    s.payload = row.get(1);
    Ok(s)
}
impl Transaction for Tx<'_> {
    fn vector(&mut self) -> Result<VersionVector> {
        Ok(self
            .tx
            .query_opt(
                "SELECT vector FROM native_vectors WHERE doc=$1",
                &[&self.doc],
            )?
            .map(|row| serde_json::from_str(row.get::<_, &str>(0)))
            .transpose()?
            .unwrap_or_default())
    }
    fn set_vector(&mut self, vv: &VersionVector) -> Result<()> {
        if self.columnar {
            self.tx
                .execute("DELETE FROM native_vectors WHERE doc=$1", &[&self.doc])?;
            self.tx.execute(
                "INSERT INTO native_vectors VALUES($1,$2)",
                &[&self.doc, &serde_json::to_string(vv)?],
            )?;
            return Ok(());
        }
        self.tx.execute("INSERT INTO native_vectors VALUES($1,$2) ON CONFLICT(doc) DO UPDATE SET vector=excluded.vector", &[&self.doc,&serde_json::to_string(vv)?])?;
        Ok(())
    }
    fn get(&mut self, sid: u64, start: u64) -> Result<Option<Segment>> {
        self.tx
            .query_opt(
                "SELECT metadata,payload FROM native_segments WHERE doc=$1 AND sid=$2 AND start=$3",
                &[&self.doc, &(sid as i64), &(start as i64)],
            )?
            .map(unpack)
            .transpose()
    }
    fn read(&mut self, remote: &VersionVector) -> Result<Vec<Segment>> {
        let sids: Vec<i64> = remote.iter().map(|(sid, _)| *sid as i64).collect();
        let clocks: Vec<i64> = remote.iter().map(|(_, clock)| *clock as i64).collect();
        self.tx.query("WITH remote(sid,clock) AS (SELECT * FROM unnest($2::bigint[],$3::bigint[])) SELECT s.metadata,s.payload FROM native_segments s LEFT JOIN remote r ON r.sid=s.sid WHERE s.doc=$1 AND s.\"end\">coalesce(r.clock,0) ORDER BY s.sid,s.start", &[&self.doc,&sids,&clocks])?.into_iter().map(unpack).collect()
    }
    fn put(&mut self, s: &Segment) -> Result<()> {
        let mut metadata = s.clone();
        metadata.payload.clear();
        self.tx.execute(
            "INSERT INTO native_segments VALUES($1,$2,$3,$4,$5,$6)",
            &[
                &self.doc,
                &(s.sid as i64),
                &(s.start as i64),
                &(s.end as i64),
                &serde_json::to_string(&metadata)?,
                &s.payload,
            ],
        )?;
        Ok(())
    }
    fn remove(&mut self, s: &Segment) -> Result<()> {
        self.tx.execute(
            "DELETE FROM native_segments WHERE doc=$1 AND sid=$2 AND start=$3",
            &[&self.doc, &(s.sid as i64), &(s.start as i64)],
        )?;
        Ok(())
    }
}
impl Session for Pg {
    fn cleanup(&mut self, prefix: &str) -> Result<()> {
        let upper = format!("{prefix}~");
        self.0.execute(
            "DELETE FROM native_segments WHERE doc >= $1 AND doc < $2",
            &[&prefix, &upper],
        )?;
        self.0.execute(
            "DELETE FROM native_vectors WHERE doc >= $1 AND doc < $2",
            &[&prefix, &upper],
        )?;
        self.0.batch_execute("CHECKPOINT")?;
        Ok(())
    }
    fn transact(&mut self, doc: &str, write: bool, work: &mut Work<'_>) -> Result<Output> {
        let mut tx = self
            .0
            .build_transaction()
            .isolation_level(if write {
                IsolationLevel::ReadCommitted
            } else {
                IsolationLevel::RepeatableRead
            })
            .read_only(!write)
            .start()?;
        if write {
            tx.query_one(
                "SELECT pg_advisory_xact_lock(hashtextextended($1,1934))",
                &[&doc],
            )?;
        }
        let mut tx = Tx {
            tx,
            doc,
            columnar: self.1,
        };
        let result = work(&mut tx)?;
        tx.tx.commit()?;
        Ok(result)
    }
}
