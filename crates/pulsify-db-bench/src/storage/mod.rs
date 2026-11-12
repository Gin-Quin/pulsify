pub mod clickhouse;
pub mod kv;
pub mod leveldb;
pub mod lmdb;
pub mod pg;
pub mod resp;
pub mod rocks;
pub mod scylla;
pub mod sqlite;

use crate::model::Segment;
use anyhow::{ensure, Result};
use pulsify_protocol::{PatchRow, VersionVector};
use std::collections::BTreeMap;

/// The ScyllaDB and ClickHouse drivers are asynchronous; worker threads block on
/// one shared runtime.
pub fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .enable_all()
            .build()
            .expect("tokio runtime")
    })
}

pub trait Transaction {
    fn vector(&mut self) -> Result<VersionVector>;
    fn set_vector(&mut self, vv: &VersionVector) -> Result<()>;
    fn get(&mut self, sid: u64, start: u64) -> Result<Option<Segment>>;
    fn read(&mut self, remote: &VersionVector) -> Result<Vec<Segment>>;
    fn put(&mut self, segment: &Segment) -> Result<()>;
    // A plan contains one actor's contiguous closed range, ordered by start.
    // Writers hold the database's document/global lock throughout validation
    // and replacement. The full segment comparison includes payload identity.
    fn matches(&mut self, sources: &[Segment]) -> Result<bool>;
    fn remove(&mut self, sources: &[Segment]) -> Result<()>;
}
#[derive(Default)]
pub struct Output {
    pub segments: Vec<Segment>,
    pub vector: VersionVector,
    pub removed: usize,
    pub stale: bool,
    pub retries: u64,
}
pub type Work<'a> = dyn FnMut(&mut dyn Transaction) -> Result<Output> + 'a;
pub trait Session: Send {
    fn transact(&mut self, doc: &str, write: bool, work: &mut Work<'_>) -> Result<Output>;
    fn cleanup(&mut self, prefix: &str) -> Result<()>;
    /// Outside the timer, once a cell's documents are seeded and again when it
    /// ends: finish the work the engine deferred (checkpoint, flush, compaction),
    /// so that no cell pays for another one.
    fn settle(&mut self, _prefix: &str) -> Result<()> {
        Ok(())
    }
}

pub fn append(session: &mut dyn Session, doc: &str, segments: &[Segment]) -> Result<Output> {
    session.transact(doc, true, &mut |tx| {
        // Keep the complete frontier in this transaction: dependency checks and the
        // final update must not re-fetch/deserialize it once per actor.
        let mut vv: BTreeMap<u64, u64> = tx.vector()?.into_iter().collect();
        let mut changed = false;
        for s in segments {
            if let Some(existing) = tx.get(s.sid, s.start)? {
                ensure!(existing == *s, "conflicting segment");
                continue;
            }
            let own = *vv.get(&s.sid).unwrap_or(&0);
            ensure!(s.start == own.max(1), "gap/overlap");
            for (sid, clock) in &s.dependencies {
                ensure!(vv.get(sid).unwrap_or(&0) >= clock, "causal dependency");
            }
            tx.put(s)?;
            vv.insert(s.sid, s.end);
            changed = true;
        }
        ensure!(
            vv.len() <= pulsify_protocol::MAX_VECTOR_ENTRIES,
            "actor limit"
        );
        if changed {
            tx.set_vector(&vv.into_iter().collect())?;
        }
        Ok(Output::default())
    })
}
pub fn read(
    session: &mut dyn Session,
    doc: &str,
    remote: &VersionVector,
) -> Result<(Output, Vec<PatchRow>)> {
    let output = session.transact(doc, false, &mut |tx| {
        Ok(Output {
            segments: tx.read(remote)?,
            vector: tx.vector()?,
            ..Default::default()
        })
    })?;
    let clocks: BTreeMap<_, _> = remote.iter().copied().collect();
    let rows: Vec<PatchRow> = output
        .segments
        .iter()
        .map(Segment::unpack)
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .flatten()
        .filter(|r| r.end() > *clocks.get(&r.sid).unwrap_or(&0))
        .collect();
    let mut coverage = clocks;
    for row in &rows {
        let have = coverage.entry(row.sid).or_insert(0);
        ensure!(
            row.clock <= (*have).max(1),
            "missing row inside database delta"
        );
        *have = (*have).max(row.end());
    }
    ensure!(
        output
            .vector
            .iter()
            .all(|(sid, c)| coverage.get(sid).unwrap_or(&0) >= c),
        "incomplete database delta"
    );
    Ok((output, rows))
}
pub fn compact(session: &mut dyn Session, doc: &str) -> Result<Output> {
    let mut total_retries = 0;
    for _ in 0..32 {
        let source = session.transact(doc, false, &mut |tx| {
            Ok(Output {
                segments: tx.read(&vec![])?,
                ..Default::default()
            })
        })?;
        total_retries += source.retries;
        let mut actors: BTreeMap<u64, Vec<Segment>> = BTreeMap::new();
        for s in source.segments {
            actors.entry(s.sid).or_default().push(s);
        }
        let mut plans = Vec::new();
        for mut sources in actors.into_values() {
            sources.pop(); // closed range: preserve the current write tail
            if sources.len() < 2 {
                continue;
            }
            // Bound historical segments to 256 KiB encoded input. Already packed segments
            // are retained rather than recompressed on every mixed-workload request.
            let mut selected = Vec::new();
            let mut bytes = 0;
            for s in sources {
                if s.compressed {
                    if selected.is_empty() {
                        continue;
                    }
                    break;
                }
                if let Some(previous) = selected.last() {
                    let previous: &Segment = previous;
                    if previous.end != s.start || bytes + s.payload.len() > 256 * 1024 {
                        break;
                    }
                }
                bytes += s.payload.len();
                selected.push(s);
            }
            if selected.len() < 2 {
                continue;
            }
            let rows = selected
                .iter()
                .map(Segment::unpack)
                .collect::<Result<Vec<_>>>()?
                .into_iter()
                .flatten()
                .collect();
            plans.push((selected, Segment::pack(rows, true)?));
        }
        if plans.is_empty() {
            return Ok(Output {
                retries: total_retries,
                ..Default::default()
            });
        }
        let mut result = session.transact(doc, true, &mut |tx| {
            for (sources, _) in &plans {
                if !tx.matches(sources)? {
                    return Ok(Output {
                        stale: true,
                        ..Default::default()
                    });
                }
            }
            let mut removed = 0;
            for (sources, replacement) in &plans {
                tx.remove(sources)?;
                tx.put(replacement)?;
                removed += sources.len() - 1;
            }
            Ok(Output {
                removed,
                ..Default::default()
            })
        })?;
        total_retries += result.retries;
        if !result.stale {
            result.retries = total_retries;
            return Ok(result);
        }
        total_retries += 1;
    }
    anyhow::bail!("compaction stale-plan retry limit")
}
