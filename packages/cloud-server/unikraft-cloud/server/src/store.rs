//! PostgreSQL storage: the shared Pulsify patch schema plus the grant table.
use crate::access::{Grant, Role};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use pulsify_protocol::{PatchRow, VersionVector};
use std::time::Duration;
use tokio_postgres::NoTls;

pub const SCHEMA: &str = include_str!("../sql/schema.sql");

/// A storage failure, mapped to a Pulsify protocol error code.
#[derive(Debug)]
pub struct StoreError {
    pub code: &'static str,
    pub message: String,
}
impl<E: std::error::Error + 'static> From<E> for StoreError {
    fn from(error: E) -> Self {
        let database = (&error as &dyn std::error::Error)
            .downcast_ref::<tokio_postgres::Error>()
            .and_then(|error| error.as_db_error())
            .map(|error| error.message().to_owned());
        match database.as_deref() {
            Some(
                message @ ("Conflicting storage segment"
                | "Overlapping segments or actor history fork"),
            ) => StoreError {
                code: "CONFLICT",
                message: message.into(),
            },
            Some(message @ "Document actor limit exceeded") => StoreError {
                code: "LIMIT_EXCEEDED",
                message: message.into(),
            },
            _ => {
                eprintln!("pulsify-cloud: storage error: {error}");
                StoreError {
                    code: "CONNECTION_FAILED",
                    message: "Storage unavailable".into(),
                }
            }
        }
    }
}
pub type StoreResult<T> = Result<T, StoreError>;

pub struct Usage {
    pub documents: i64,
    pub rows: i64,
    pub bytes: i64,
}

#[derive(Clone)]
pub struct Store {
    pool: Pool,
}

impl Store {
    pub fn connect(database_url: &str, size: usize) -> Result<Self, Box<dyn std::error::Error>> {
        let config: tokio_postgres::Config = database_url.parse()?;
        let manager = Manager::from_config(
            config,
            NoTls,
            ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            },
        );
        Ok(Self {
            pool: Pool::builder(manager).max_size(size).build()?,
        })
    }

    /// Install the schema, waiting for PostgreSQL to accept connections.
    pub async fn initialize(&self, attempts: u32) -> StoreResult<()> {
        let mut attempt = 0;
        loop {
            let result = async {
                let client = self.pool.get().await?;
                client.batch_execute(SCHEMA).await?;
                StoreResult::Ok(())
            }
            .await;
            attempt += 1;
            if result.is_ok() || attempt >= attempts {
                return result;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    pub async fn grants(&self, root: &str) -> StoreResult<Vec<Grant>> {
        let client = self.pool.get().await?;
        let statement = client
            .prepare_cached(
                "SELECT subject, prefix, role FROM pulsify_cloud_grants WHERE root = $1",
            )
            .await?;
        Ok(client
            .query(&statement, &[&root])
            .await?
            .into_iter()
            .filter_map(|row| {
                Some(Grant {
                    subject: row.get(0),
                    prefix: row.get(1),
                    role: Role::parse(row.get(2))?,
                })
            })
            .collect())
    }

    pub async fn put_grant(&self, root: &str, grant: &Grant) -> StoreResult<()> {
        let client = self.pool.get().await?;
        let statement = client
            .prepare_cached(
                "INSERT INTO pulsify_cloud_grants(root, subject, prefix, role) VALUES($1, $2, $3, $4) \
                 ON CONFLICT(root, subject, prefix) DO UPDATE SET role = excluded.role",
            )
            .await?;
        client
            .execute(
                &statement,
                &[&root, &grant.subject, &grant.prefix, &grant.role.as_str()],
            )
            .await?;
        Ok(())
    }

    pub async fn delete_grant(&self, root: &str, subject: &str, prefix: &str) -> StoreResult<bool> {
        let client = self.pool.get().await?;
        let statement = client
            .prepare_cached(
                "DELETE FROM pulsify_cloud_grants WHERE root = $1 AND subject = $2 AND prefix = $3",
            )
            .await?;
        Ok(client
            .execute(&statement, &[&root, &subject, &prefix])
            .await?
            > 0)
    }

    pub async fn vector(&self, doc_id: &str) -> StoreResult<VersionVector> {
        let client = self.pool.get().await?;
        let statement = client
            .prepare_cached(
                "SELECT sid, clock FROM pulsify_doc_clocks WHERE doc_id = $1 ORDER BY sid",
            )
            .await?;
        Ok(client
            .query(&statement, &[&doc_id])
            .await?
            .into_iter()
            .map(|row| (row.get::<_, i64>(0) as u64, row.get::<_, i64>(1) as u64))
            .collect())
    }

    /// Rows the peer lacks, straight from the index, without reading a document.
    pub async fn missing(
        &self,
        doc_id: &str,
        remote: &VersionVector,
    ) -> StoreResult<Vec<PatchRow>> {
        let client = self.pool.get().await?;
        let statement = client
            .prepare_cached(
                "WITH remote(sid, clock) AS (SELECT * FROM unnest($2::bigint[], $3::bigint[])) \
                 SELECT o.sid, o.time_start, o.span, o.dependencies::text, o.operations \
                 FROM pulsify_op_rows o LEFT JOIN remote r ON r.sid = o.sid \
                 WHERE o.doc_id = $1 AND o.ready AND o.time_end > COALESCE(r.clock, 0) \
                 ORDER BY o.sid, o.time_start",
            )
            .await?;
        let sids: Vec<i64> = remote.iter().map(|(sid, _)| *sid as i64).collect();
        let clocks: Vec<i64> = remote.iter().map(|(_, clock)| *clock as i64).collect();
        let mut rows = Vec::new();
        for row in client.query(&statement, &[&doc_id, &sids, &clocks]).await? {
            rows.push(PatchRow {
                doc_id: doc_id.to_owned(),
                sid: row.get::<_, i64>(0) as u64,
                clock: row.get::<_, i64>(1) as u64,
                span: row.get::<_, i64>(2) as u64,
                dependencies: serde_json::from_str(row.get::<_, &str>(3))?,
                operations: row.get(4),
            });
        }
        Ok(rows)
    }

    /// One `pulsify_append` call: lock, validate, insert and promote in one transaction.
    pub async fn append(&self, doc_id: &str, rows: &[PatchRow]) -> StoreResult<i32> {
        if rows.is_empty() {
            return Ok(0);
        }
        let metadata = serde_json::to_string(
            &rows
                .iter()
                .map(|row| serde_json::json!([row.sid, row.clock, row.span, row.dependencies]))
                .collect::<Vec<_>>(),
        )?;
        let payloads: Vec<&[u8]> = rows.iter().map(|row| row.operations.as_slice()).collect();
        let client = self.pool.get().await?;
        let statement = client
            .prepare_cached(
                "SELECT inserted FROM pulsify_append($1::text, $2::text::jsonb, $3::bytea[])",
            )
            .await?;
        Ok(client
            .query_one(&statement, &[&doc_id, &metadata, &payloads])
            .await?
            .get(0))
    }

    pub async fn usage(&self, root: &str) -> StoreResult<Usage> {
        let client = self.pool.get().await?;
        let statement = client
            .prepare_cached(
                "SELECT COUNT(DISTINCT doc_id)::bigint, COUNT(*)::bigint, COALESCE(SUM(octet_length(operations)), 0)::bigint \
                 FROM pulsify_op_rows WHERE doc_id = $1::text OR starts_with(doc_id, $1::text || '/')",
            )
            .await?;
        let row = client.query_one(&statement, &[&root]).await?;
        Ok(Usage {
            documents: row.get(0),
            rows: row.get(1),
            bytes: row.get(2),
        })
    }
}
