use crate::{Error, Result};
use pulsify_protocol::{document_prefixes, DocumentStore};
use pulsify_protocol::{
    is_gap, last_register_of, validate_rows, validate_vector, AppendResult, PatchRow, PatchStore,
    VersionVector, GAP_OPERATIONS, MAX_VECTOR_ENTRIES,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::Duration;

/// Byte-for-byte `SQLITE_PATCH_SCHEMA` from `pulsify-core/storage`.
pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS pulsify_tombstones (prefix TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS pulsify_op_rows (
 doc_id TEXT NOT NULL, sid INTEGER NOT NULL, time_start INTEGER NOT NULL,
 span INTEGER NOT NULL CHECK(span > 0), time_end INTEGER GENERATED ALWAYS AS (time_start + span) STORED,
 dependencies TEXT NOT NULL, operations BLOB NOT NULL, ready INTEGER NOT NULL DEFAULT 0,
 packed INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(doc_id, sid, time_start)
) WITHOUT ROWID;
DROP INDEX IF EXISTS pulsify_rows_frontier;
CREATE INDEX IF NOT EXISTS pulsify_rows_pending ON pulsify_op_rows(doc_id) WHERE ready = 0;
CREATE TABLE IF NOT EXISTS pulsify_doc_clocks (
 doc_id TEXT NOT NULL, sid INTEGER NOT NULL, clock INTEGER NOT NULL,
 PRIMARY KEY(doc_id, sid)
) WITHOUT ROWID;
CREATE VIEW IF NOT EXISTS pulsify_dangling_op_rows AS SELECT * FROM pulsify_op_rows WHERE ready = 0;
CREATE TABLE IF NOT EXISTS pulsify_values (
 doc_id TEXT NOT NULL, sid INTEGER NOT NULL, register BLOB NOT NULL, clock INTEGER NOT NULL,
 dependencies TEXT NOT NULL, operations BLOB NOT NULL,
 PRIMARY KEY(doc_id, sid, register)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS pulsify_values_clock ON pulsify_values(doc_id, sid, clock);
";

/// Byte-for-byte `SQLITE_REGISTERS_MIGRATION`: moves the last-value rows of a
/// database written by an unreleased layout, which indexed them in
/// `pulsify_registers`, to `pulsify_values`, and drops its gap rows.
pub const REGISTERS_MIGRATION: &str = "
INSERT OR REPLACE INTO pulsify_values(doc_id,sid,register,clock,dependencies,operations)
 SELECT o.doc_id,o.sid,r.register,o.time_start,o.dependencies,o.operations FROM pulsify_registers r
 JOIN pulsify_op_rows o ON o.doc_id=r.doc_id AND o.sid=r.sid AND o.time_start=r.clock
 WHERE o.ready=1 AND o.packed=0;
DELETE FROM pulsify_op_rows WHERE ready=1 AND packed=0 AND (operations=X'03010000' OR EXISTS(
 SELECT 1 FROM pulsify_registers r WHERE r.doc_id=pulsify_op_rows.doc_id AND r.sid=pulsify_op_rows.sid
 AND r.clock=pulsify_op_rows.time_start));
DROP TABLE pulsify_registers;
";

/// Byte-for-byte `SQLITE_PACKED_MIGRATION`: added to a table created before packed segments.
pub const PACKED_MIGRATION: &str =
    "ALTER TABLE pulsify_op_rows ADD COLUMN packed INTEGER NOT NULL DEFAULT 0";

/// Rows keyed by `(doc_id, sid, time_start)`, whose operations are immutable.
/// Rows stay pending until their actor prefix is contiguous and their
/// dependencies are stored. A field without history keeps each actor's newest
/// write to it in `pulsify_values`, overwritten in place: the sequence numbers
/// of the writes it replaces hold nothing, and spans are computed when rows
/// are read.
pub struct SqliteStore {
    db: Connection,
}

impl SqliteStore {
    /// Opens or creates a durable database file (WAL, synchronous FULL).
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")?;
        Self::new(db)
    }
    pub fn open_in_memory() -> Result<Self> {
        Self::new(Connection::open_in_memory()?)
    }
    /// Installs the schema on an existing connection.
    pub fn new(mut db: Connection) -> Result<Self> {
        // An append and a read keep about twenty statements between them.
        db.set_prepared_statement_cache_capacity(64);
        db.execute_batch(SCHEMA)?;
        // CREATE TABLE IF NOT EXISTS leaves an older table as it is.
        let packed = || -> Result<bool> {
            Ok(db.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('pulsify_op_rows') WHERE name='packed'",
                [],
                |r| r.get(0),
            )?)
        };
        if !packed()? {
            if let Err(error) = db.execute_batch(PACKED_MIGRATION) {
                // Another process that opened the file at the same time added it.
                if !packed()? {
                    return Err(error.into());
                }
            }
        }
        let registers = |db: &Connection| -> Result<bool> {
            Ok(db.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='pulsify_registers'",
                [],
                |r| r.get::<_, i64>(0),
            )? > 0)
        };
        if registers(&db)? {
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            // Another process may have moved them first.
            if registers(&tx)? {
                tx.execute_batch(REGISTERS_MIGRATION)?;
            }
            tx.commit()?;
        }
        Ok(Self { db })
    }
    /// Retain local recovery data and permanently block the prefix, in one transaction.
    pub fn mark_deleted(&mut self, doc_id: &str, frames: &[Vec<u8>]) -> Result<()> {
        validate_doc_id(doc_id)?;
        let result = (|| -> Result<()> {
            let tx = self
                .db
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            for frame in frames {
                let message = pulsify_protocol::decode(frame)?;
                if !pulsify_protocol::covers_document(doc_id, &message.doc_id) {
                    return Err(Error::new(
                        "INVALID_MESSAGE",
                        "Recovery row outside deleted subtree",
                    ));
                }
                let pulsify_protocol::Body::SyncBack { rows, .. } = message.body else {
                    return Err(Error::new("INVALID_MESSAGE", "Invalid recovery frame"));
                };
                if !rows.is_empty() {
                    append_rows(&tx, &message.doc_id, &rows)?;
                }
            }
            if !is_deleted(&tx, doc_id)? {
                tx.execute(
                    "DELETE FROM pulsify_tombstones WHERE prefix>=?1 AND prefix<?2",
                    params![format!("{doc_id}/"), format!("{doc_id}0")],
                )?;
                tx.execute("INSERT INTO pulsify_tombstones(prefix) VALUES(?)", [doc_id])?;
            }
            tx.commit()?;
            Ok(())
        })();
        // Even failed recovery must not make an authoritatively deleted ID live.
        self.delete_documents(doc_id, true)?;
        result
    }
    pub fn connection(&self) -> &Connection {
        &self.db
    }

    /// Validates and stores rows of one document in one IMMEDIATE transaction.
    /// Retransmissions are ignored; a conflict rolls back the whole batch.
    pub fn append(&mut self, rows: &[PatchRow]) -> Result<AppendResult> {
        let Some(doc_id) = validate_rows(rows)? else {
            return Ok(AppendResult::default());
        };
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        assert_live(&tx, doc_id)?;
        let result = append_rows(&tx, doc_id, rows)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn vector(&self, doc_id: &str) -> Result<VersionVector> {
        validate_doc_id(doc_id)?;
        assert_live(&self.db, doc_id)?;
        read_vector(&self.db, doc_id)
    }

    /// Ready rows the peer lacks, ordered by actor and clock.
    pub fn missing(&self, doc_id: &str, remote: &VersionVector) -> Result<Vec<PatchRow>> {
        validate_doc_id(doc_id)?;
        validate_vector(remote)?;
        assert_live(&self.db, doc_id)?;
        read_missing(&self.db, doc_id, remote)
    }

    /// `missing` and `vector` from one consistent snapshot.
    pub fn sync_state(
        &mut self,
        doc_id: &str,
        remote: &VersionVector,
    ) -> Result<(Vec<PatchRow>, VersionVector)> {
        validate_doc_id(doc_id)?;
        validate_vector(remote)?;
        let tx = self.db.transaction()?;
        assert_live(&tx, doc_id)?;
        let rows = read_missing(&tx, doc_id, remote)?;
        let vector = read_vector(&tx, doc_id)?;
        tx.commit()?;
        Ok((rows, vector))
    }
}

fn is_deleted(db: &Connection, doc_id: &str) -> Result<bool> {
    validate_doc_id(doc_id)?;
    let mut get = db.prepare_cached("SELECT 1 FROM pulsify_tombstones WHERE prefix=?")?;
    for prefix in document_prefixes(doc_id) {
        if get.exists([prefix])? {
            return Ok(true);
        }
    }
    Ok(false)
}
fn assert_live(db: &Connection, doc_id: &str) -> Result<()> {
    if is_deleted(db, doc_id)? {
        return Err(Error::new(
            "NOT_FOUND",
            format!("Document {doc_id} was permanently deleted"),
        ));
    }
    Ok(())
}
impl DocumentStore for SqliteStore {
    fn is_deleted(&self, doc_id: &str) -> Result<bool> {
        is_deleted(&self.db, doc_id)
    }
    fn delete_documents(&mut self, doc_id: &str, preserve_rows: bool) -> Result<usize> {
        validate_doc_id(doc_id)?;
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let lower = format!("{doc_id}/");
        let upper = format!("{doc_id}0");
        if !is_deleted(&tx, doc_id)? {
            tx.execute(
                "DELETE FROM pulsify_tombstones WHERE prefix=?1 OR (prefix>=?2 AND prefix<?3)",
                params![doc_id, lower, upper],
            )?;
            tx.execute("INSERT INTO pulsify_tombstones(prefix) VALUES(?)", [doc_id])?;
        }
        let mut count = 0;
        if !preserve_rows {
            count = tx.query_row("SELECT COUNT(*) FROM (SELECT doc_id FROM pulsify_op_rows WHERE doc_id=?1 OR (doc_id>=?2 AND doc_id<?3) UNION SELECT doc_id FROM pulsify_values WHERE doc_id=?1 OR (doc_id>=?2 AND doc_id<?3))", params![doc_id, lower, upper], |r| r.get::<_, i64>(0))? as usize;
            for table in ["pulsify_op_rows", "pulsify_values", "pulsify_doc_clocks"] {
                tx.execute(
                    &format!("DELETE FROM {table} WHERE doc_id=?1 OR (doc_id>=?2 AND doc_id<?3)"),
                    params![doc_id, lower, upper],
                )?;
            }
        }
        tx.commit()?;
        Ok(count)
    }
    fn recover_rows(&self, doc_id: &str) -> Result<Vec<PatchRow>> {
        validate_doc_id(doc_id)?;
        read_missing(&self.db, doc_id, &vec![])
    }
    fn documents(&self, doc_id: &str, after: &str, limit: usize) -> Result<Vec<String>> {
        assert_live(&self.db, doc_id)?;
        if limit == 0 || limit > 4096 {
            return Err(Error::new("INVALID_MESSAGE", "Invalid document limit"));
        }
        let mut result = Vec::new();
        if self
            .db
            .prepare_cached(
                "SELECT 1 FROM pulsify_doc_clocks WHERE doc_id=?1 AND doc_id>?2 LIMIT 1",
            )?
            .exists(params![doc_id, after])?
        {
            result.push(doc_id.to_owned());
        }
        // Range seeks plus indexed ancestor lookups: never scan the tombstone table.
        let lower = format!("{doc_id}/");
        let upper = format!("{doc_id}0");
        let mut cursor = after.to_owned();
        let mut query = self.db.prepare_cached("SELECT DISTINCT doc_id FROM pulsify_doc_clocks WHERE doc_id>=MAX(?1,?2) AND doc_id<?3 AND doc_id>?2 ORDER BY doc_id LIMIT ?4")?;
        while result.len() < limit {
            let candidates = query
                .query_map(
                    params![lower, cursor, upper, (limit - result.len()) as i64],
                    |r| r.get::<_, String>(0),
                )?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let Some(last) = candidates.last() else {
                break;
            };
            cursor = last.clone();
            for id in candidates {
                if !is_deleted(&self.db, &id)? {
                    result.push(id);
                }
            }
        }
        Ok(result)
    }
}

impl PatchStore for SqliteStore {
    type Error = Error;
    fn append(&mut self, rows: &[PatchRow]) -> Result<AppendResult> {
        SqliteStore::append(self, rows)
    }
    fn vector(&self, doc_id: &str) -> Result<VersionVector> {
        SqliteStore::vector(self, doc_id)
    }
    fn missing(&self, doc_id: &str, remote: &VersionVector) -> Result<Vec<PatchRow>> {
        SqliteStore::missing(self, doc_id, remote)
    }
    fn sync_state(
        &mut self,
        doc_id: &str,
        remote: &VersionVector,
    ) -> Result<(Vec<PatchRow>, VersionVector)> {
        SqliteStore::sync_state(self, doc_id, remote)
    }
}

pub fn validate_doc_id(doc_id: &str) -> Result<()> {
    Ok(pulsify_protocol::validate_doc_id(doc_id)?)
}

fn own_clock(vv: &VersionVector, sid: u64) -> u64 {
    vv.iter()
        .find(|(id, _)| *id == sid)
        .map_or(0, |(_, clock)| *clock)
}

fn conflict(message: &str) -> Error {
    Error::new("CONFLICT", message)
}

fn corrupt() -> Error {
    Error::new("CONNECTION_FAILED", "Corrupt packed segment")
}

/// The rows of a packed segment, as `SqlitePatchStore.compact` folded them:
/// for each, `span`, the dependencies and the operation bytes, numbers as
/// LEB128 varuints. Their spans tile the segment, from its clock to its end:
/// a span runs to the next row, and a gap row fills a hole before a row that
/// extended the segment.
fn unpack(doc_id: &str, sid: u64, clock: u64, span: u64, bytes: &[u8]) -> Result<Vec<PatchRow>> {
    let mut offset = 0;
    let read = |offset: &mut usize| -> Result<u64> {
        let mut value = 0u64;
        for shift in (0..).step_by(7) {
            let byte = *bytes.get(*offset).ok_or_else(corrupt)?;
            *offset += 1;
            if shift > 49 {
                return Err(corrupt());
            }
            value |= u64::from(byte & 127) << shift;
            if byte < 128 {
                break;
            }
        }
        Ok(value)
    };
    let mut rows = Vec::new();
    let mut next = clock;
    while offset < bytes.len() {
        let span = read(&mut offset)?;
        let count = read(&mut offset)?;
        let mut dependencies = VersionVector::new();
        for _ in 0..count {
            dependencies.push((read(&mut offset)?, read(&mut offset)?));
        }
        let length = read(&mut offset)? as usize;
        let operations = offset
            .checked_add(length)
            .and_then(|end| bytes.get(offset..end))
            .filter(|operations| span > 0 && !operations.is_empty())
            .ok_or_else(corrupt)?;
        rows.push(PatchRow {
            doc_id: doc_id.to_owned(),
            sid,
            clock: next,
            span,
            dependencies,
            operations: operations.to_vec(),
        });
        offset += length;
        next = next.checked_add(span).ok_or_else(corrupt)?;
    }
    if rows.is_empty() || next != clock + span {
        return Err(corrupt());
    }
    Ok(rows)
}

/// A stored row, as an append reads it.
struct Stored {
    clock: u64,
    span: u64,
    operations: Vec<u8>,
    packed: bool,
}
impl Stored {
    const COLUMNS: &'static str = "time_start,span,operations,packed";
    fn read(r: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            clock: r.get::<_, i64>(0)? as u64,
            span: r.get::<_, i64>(1)? as u64,
            operations: r.get(2)?,
            packed: r.get(3)?,
        })
    }
    fn end(&self) -> u64 {
        self.clock + self.span
    }
}

/// A row that waits for its predecessors or its dependencies.
struct Waiting {
    sid: u64,
    start: u64,
    end: u64,
    dependencies: VersionVector,
}

/// Other operations at the same identity. A gap row stands for any replaced write.
fn differ(held: &[u8], incoming: &[u8]) -> bool {
    !is_gap(held) && !is_gap(incoming) && held != incoming
}
fn covered(frontier: &BTreeMap<u64, u64>, dependencies: &VersionVector) -> bool {
    dependencies
        .iter()
        .all(|(actor, clock)| frontier.get(actor).copied().unwrap_or(0) >= *clock)
}

/// The rows of one document, inside the transaction of an append.
struct Rows<'a> {
    tx: &'a Transaction<'a>,
    doc_id: &'a str,
}
impl Rows<'_> {
    fn get(&self, sid: u64, clock: u64) -> Result<Option<Stored>> {
        Ok(self
            .tx
            .prepare_cached(&format!(
                "SELECT {} FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND time_start=?",
                Stored::COLUMNS
            ))?
            .query_row(params![self.doc_id, sid as i64, clock as i64], Stored::read)
            .optional()?)
    }
    /// The last row of the actor that starts before this sequence number.
    fn before(&self, sid: u64, clock: u64) -> Result<Option<Stored>> {
        Ok(self
            .tx
            .prepare_cached(&format!(
                "SELECT {} FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND time_start<? ORDER BY time_start DESC LIMIT 1",
                Stored::COLUMNS
            ))?
            .query_row(params![self.doc_id, sid as i64, clock as i64], Stored::read)
            .optional()?)
    }
    fn insert(
        &self,
        sid: u64,
        clock: u64,
        span: u64,
        dependencies: &str,
        operations: &[u8],
        ready: bool,
    ) -> Result<()> {
        self.tx
            .prepare_cached(
                "INSERT INTO pulsify_op_rows(doc_id,sid,time_start,span,dependencies,operations,ready) VALUES(?,?,?,?,?,?,?)",
            )?
            .execute(params![
                self.doc_id,
                sid as i64,
                clock as i64,
                span as i64,
                dependencies,
                operations,
                ready,
            ])?;
        Ok(())
    }
    fn set_span(&self, sid: u64, clock: u64, span: u64) -> Result<()> {
        self.tx
            .prepare_cached(
                "UPDATE pulsify_op_rows SET span=? WHERE doc_id=? AND sid=? AND time_start=?",
            )?
            .execute(params![span as i64, self.doc_id, sid as i64, clock as i64])?;
        Ok(())
    }
    /// Removes the rows of an actor that wait in `[from, to)`: they were replaced.
    fn remove_waiting(&self, sid: u64, from: u64, to: u64) -> Result<()> {
        self.tx
            .prepare_cached(
                "DELETE FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND ready=0 AND time_start>=? AND time_start<?",
            )?
            .execute(params![self.doc_id, sid as i64, from as i64, to as i64])?;
        Ok(())
    }
    /// The operations held at this sequence number: a stored row, a row inside
    /// a packed segment, or an actor's value of a register.
    fn held_at(
        &self,
        values: &mut HashMap<u64, HashMap<u64, Vec<u8>>>,
        sid: u64,
        clock: u64,
    ) -> Result<Option<Vec<u8>>> {
        let unpack = |stored: &Stored| {
            unpack(
                self.doc_id,
                sid,
                stored.clock,
                stored.span,
                &stored.operations,
            )
        };
        if let Some(exact) = self.get(sid, clock)? {
            if !exact.packed {
                return Ok(Some(exact.operations));
            }
            // A packed segment starts with the row that had its key.
            return Ok(unpack(&exact)?.into_iter().next().map(|row| row.operations));
        }
        if let Some(previous) = self.before(sid, clock)? {
            if previous.packed && clock < previous.end() {
                if let Some(inner) = unpack(&previous)?
                    .into_iter()
                    .find(|row| row.clock == clock)
                {
                    return Ok(Some(inner.operations));
                }
            }
        }
        // Where each value of the actor is, read once for rows sent again.
        let clocks = match values.entry(sid) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => entry.insert(
                self.tx
                    .prepare_cached(
                        "SELECT clock,register FROM pulsify_values WHERE doc_id=? AND sid=?",
                    )?
                    .query_map(params![self.doc_id, sid as i64], |r| {
                        Ok((r.get::<_, i64>(0)? as u64, r.get::<_, Vec<u8>>(1)?))
                    })?
                    .collect::<rusqlite::Result<HashMap<_, _>>>()?,
            ),
        };
        let Some(register) = clocks.get(&clock) else {
            return Ok(None);
        };
        Ok(Some(
            self.tx
                .prepare_cached(
                    "SELECT operations FROM pulsify_values WHERE doc_id=? AND sid=? AND register=?",
                )?
                .query_row(params![self.doc_id, sid as i64, register], |r| r.get(0))?,
        ))
    }
    /// Stores a ready row: a last-value row as its actor's value of the
    /// register, replacing the older one; a gap row not at all, as the
    /// frontier says how far the actor goes. Whether it stays a row.
    fn keep(
        &self,
        values: &mut HashMap<u64, HashMap<u64, Vec<u8>>>,
        sid: u64,
        clock: u64,
        dependencies: &str,
        operations: &[u8],
    ) -> Result<bool> {
        let Some(last) = last_register_of(operations) else {
            return Ok(!is_gap(operations));
        };
        self.tx
            .prepare_cached(
                "INSERT INTO pulsify_values(doc_id,sid,register,clock,dependencies,operations) VALUES(?,?,?,?,?,?) ON CONFLICT(doc_id,sid,register) DO UPDATE SET clock=excluded.clock,dependencies=excluded.dependencies,operations=excluded.operations",
            )?
            .execute(params![
                self.doc_id,
                sid as i64,
                last.register,
                clock as i64,
                dependencies,
                operations,
            ])?;
        values.remove(&sid);
        Ok(false)
    }
}

/// Mirror of `SqlitePatchStore.append`, statement for statement.
fn append_rows(tx: &Transaction<'_>, doc_id: &str, rows: &[PatchRow]) -> Result<AppendResult> {
    let stored = Rows { tx, doc_id };
    let mut after = tx.prepare_cached(
        "SELECT dependencies FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND time_start>=? ORDER BY time_start LIMIT 1",
    )?;
    let mut frontier: BTreeMap<u64, u64> = read_vector(tx, doc_id)?.into_iter().collect();
    // Pending rows are few: read them through the partial index, which the
    // planner would otherwise skip for the primary key and read the whole
    // document. Its entries end with the primary key, so they come sorted.
    let mut pending = tx
        .prepare_cached(
            "SELECT sid,time_start,time_end,dependencies FROM pulsify_op_rows INDEXED BY pulsify_rows_pending WHERE doc_id=? AND ready=0 ORDER BY sid,time_start",
        )?
        .query_map([doc_id], |r| {
            Ok((
                r.get::<_, i64>(0)? as u64,
                r.get::<_, i64>(1)? as u64,
                r.get::<_, i64>(2)? as u64,
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .map(|(sid, start, end, dependencies)| {
            Ok(Waiting {
                sid,
                start,
                end,
                dependencies: serde_json::from_str(&dependencies)?,
            })
        })
        .collect::<Result<Vec<Waiting>>>()?;
    let mut pending_actors: BTreeSet<u64> = pending.iter().map(|row| row.sid).collect();
    let mut changed_actors = BTreeSet::new();
    let mut values = HashMap::new();
    let (mut inserted, mut ready) = (0, 0);
    for row in rows {
        let (sid, clock, end) = (row.sid, row.clock, row.clock + row.span);
        let reached = frontier.get(&sid).copied().unwrap_or(1);
        if clock < reached {
            // Known, or replaced here: only its contents can conflict, and
            // only its span can say that more writes were replaced.
            if let Some(held) = stored.held_at(&mut values, sid, clock)? {
                if differ(&held, &row.operations) {
                    return Err(conflict("Conflicting storage segment"));
                }
            }
            if end <= reached {
                continue;
            }
            // Rows that waited below the new frontier were replaced.
            stored.remove_waiting(sid, reached, end)?;
            pending.retain(|each| each.sid != sid || each.start >= end);
            frontier.insert(sid, end);
            changed_actors.insert(sid);
            inserted += 1;
            continue;
        }
        // A row that is ready on arrival (the common, in-order case) skips the
        // pending index and the promotion UPDATE.
        let ready_now = clock == reached && covered(&frontier, &row.dependencies);
        if ready_now && !pending_actors.contains(&sid) {
            // Ready rows of an actor start below the frontier and it has no
            // pending row, so no stored row starts at or after this one: it is
            // neither a duplicate nor overlapping. Only the fork check remains,
            // without reading anything.
            if clock > 1 && own_clock(&row.dependencies, sid) < clock {
                return Err(conflict("Actor history fork"));
            }
        } else {
            if let Some(existing) = stored.get(sid, clock)? {
                // A waiting row with the same start: only contents conflict.
                if differ(&existing.operations, &row.operations) {
                    return Err(conflict("Conflicting storage segment"));
                }
                // The longer span knows of more replaced writes, the waiting
                // rows that start inside it among them.
                if row.span > existing.span {
                    stored.set_span(sid, clock, row.span)?;
                    stored.remove_waiting(sid, clock + 1, end)?;
                    pending
                        .retain(|each| each.sid != sid || each.start <= clock || each.start >= end);
                    for each in pending.iter_mut() {
                        if each.sid == sid && each.start == clock {
                            each.end = end;
                        }
                    }
                }
                continue;
            }
            let own = own_clock(&row.dependencies, sid);
            if let Some(previous) = stored.before(sid, clock)? {
                // It starts among the writes a waiting row has replaced.
                if previous.end() > clock {
                    continue;
                }
                if own < previous.end() {
                    return Err(conflict("Actor history fork"));
                }
            }
            // The first row past its span builds on it, like the journal checks.
            let next = after
                .query_row(params![doc_id, sid as i64, end as i64], |r| {
                    r.get::<_, String>(0)
                })
                .optional()?;
            if let Some(next) = next {
                let dependencies: VersionVector = serde_json::from_str(&next)?;
                if own_clock(&dependencies, sid) < end {
                    return Err(conflict("Actor history fork"));
                }
            }
            // Rows still waiting that this row has replaced.
            stored.remove_waiting(sid, clock + 1, end)?;
            pending.retain(|each| each.sid != sid || each.start <= clock || each.start >= end);
        }
        let dependencies = serde_json::to_string(&row.dependencies)?;
        inserted += 1;
        if ready_now {
            if stored.keep(&mut values, sid, clock, &dependencies, &row.operations)? {
                stored.insert(sid, clock, row.span, &dependencies, &row.operations, true)?;
            }
            frontier.insert(sid, end);
            changed_actors.insert(sid);
            ready += 1;
        } else {
            stored.insert(sid, clock, row.span, &dependencies, &row.operations, false)?;
            pending.push(Waiting {
                sid,
                start: clock,
                end,
                dependencies: row.dependencies.clone(),
            });
            pending_actors.insert(sid);
        }
    }
    let actors: BTreeSet<u64> = frontier
        .keys()
        .chain(pending_actors.iter())
        .copied()
        .collect();
    if actors.len() > MAX_VECTOR_ENTRIES {
        return Err(Error::new(
            "LIMIT_EXCEEDED",
            "Document actor limit exceeded",
        ));
    }
    let mut promote = tx.prepare_cached(
        "UPDATE pulsify_op_rows SET ready=1 WHERE doc_id=? AND sid=? AND time_start=?",
    )?;
    let mut remove =
        tx.prepare_cached("DELETE FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND time_start=?")?;
    pending.sort_by_key(|row| (row.sid, row.start));
    loop {
        let mut changed = false;
        let mut waiting = Vec::new();
        for row in pending {
            let contiguous = row.start == frontier.get(&row.sid).copied().unwrap_or(1);
            if !contiguous || !covered(&frontier, &row.dependencies) {
                waiting.push(row);
                continue;
            }
            let (dependencies, operations): (String, Vec<u8>) = tx
                .prepare_cached(
                    "SELECT dependencies,operations FROM pulsify_op_rows WHERE doc_id=? AND sid=? AND time_start=?",
                )?
                .query_row(params![doc_id, row.sid as i64, row.start as i64], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?;
            if stored.keep(&mut values, row.sid, row.start, &dependencies, &operations)? {
                promote.execute(params![doc_id, row.sid as i64, row.start as i64])?;
            } else {
                remove.execute(params![doc_id, row.sid as i64, row.start as i64])?;
            }
            let clock = frontier.entry(row.sid).or_insert(0);
            *clock = (*clock).max(row.end);
            changed_actors.insert(row.sid);
            ready += 1;
            changed = true;
        }
        pending = waiting;
        if !changed {
            break;
        }
    }
    let mut advance = tx.prepare_cached(
        "INSERT INTO pulsify_doc_clocks(doc_id,sid,clock) VALUES(?,?,?) ON CONFLICT(doc_id,sid) DO UPDATE SET clock=MAX(clock,excluded.clock)",
    )?;
    for sid in changed_actors {
        advance.execute(params![doc_id, sid as i64, frontier[&sid] as i64])?;
    }
    Ok(AppendResult {
        inserted,
        ready,
        pending: pending.len(),
        vector: Some(frontier.into_iter().collect()),
    })
}

fn read_vector(db: &Connection, doc_id: &str) -> Result<VersionVector> {
    Ok(db
        .prepare_cached("SELECT sid,clock FROM pulsify_doc_clocks WHERE doc_id=? ORDER BY sid")?
        .query_map([doc_id], |r| {
            Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64))
        })?
        .collect::<rusqlite::Result<_>>()?)
}

/// Mirror of `SqlitePatchStore.missing`: the rows still held, with spans
/// computed from the next one, and a gap row where none holds the remote clock.
fn read_missing(db: &Connection, doc_id: &str, remote: &VersionVector) -> Result<Vec<PatchRow>> {
    let behind: Vec<(u64, u64)> = read_vector(db, doc_id)?
        .into_iter()
        .filter(|(sid, clock)| *clock > own_clock(remote, *sid))
        .collect();
    if behind.is_empty() {
        return Ok(Vec::new());
    }
    let remote_json = serde_json::to_string(remote)?;
    // Each table is read from its last row starting at or before the remote
    // clock: one primary key seek per behind actor for the rows, one pass
    // over its values, as `SqlitePatchStore.missing` does.
    let sql = |table: &str, clock: &str, columns: &str| {
        if remote.is_empty() {
            format!("SELECT {columns} FROM {table} o WHERE o.doc_id=?2")
        } else {
            format!(
                "WITH remote(sid,clock) AS (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?1)),
 actors(sid,since) AS (SELECT c.sid,MAX(COALESCE(r.clock,0),1) FROM pulsify_doc_clocks c LEFT JOIN remote r ON r.sid=c.sid
  WHERE c.doc_id=?2 AND c.clock>COALESCE(r.clock,0))
 SELECT {columns} FROM actors a CROSS JOIN {table} o WHERE o.doc_id=?2 AND o.sid=a.sid
 AND o.{clock}>=COALESCE((SELECT MAX({clock}) FROM {table} WHERE doc_id=?2 AND sid=a.sid AND {clock}<=a.since),0)"
            )
        }
    };
    let bind = |statement: &mut rusqlite::CachedStatement<'_>| -> rusqlite::Result<()> {
        if !remote.is_empty() {
            statement.raw_bind_parameter(1, &remote_json)?;
        }
        statement.raw_bind_parameter(2, doc_id)
    };
    let mut held: BTreeMap<u64, Vec<PatchRow>> = BTreeMap::new();
    let mut hold = |row: PatchRow| {
        if !is_gap(&row.operations) {
            held.entry(row.sid).or_default().push(row);
        }
    };
    let mut statement = db.prepare_cached(&sql(
        "pulsify_op_rows",
        "time_start",
        "o.sid,o.time_start,o.span,o.dependencies,o.operations,o.packed,o.ready",
    ))?;
    bind(&mut statement)?;
    let mut found = statement.raw_query();
    while let Some(r) = found.next()? {
        if !r.get::<_, bool>(6)? {
            continue;
        }
        let (sid, clock, span) = (
            r.get::<_, i64>(0)? as u64,
            r.get::<_, i64>(1)? as u64,
            r.get::<_, i64>(2)? as u64,
        );
        let operations: Vec<u8> = r.get(4)?;
        if r.get::<_, bool>(5)? {
            // Packed segments never reach a peer: it gets the rows inside.
            unpack(doc_id, sid, clock, span, &operations)?
                .into_iter()
                .for_each(&mut hold);
        } else {
            hold(PatchRow {
                doc_id: doc_id.to_owned(),
                sid,
                clock,
                span,
                dependencies: serde_json::from_str(&r.get::<_, String>(3)?)?,
                operations,
            });
        }
    }
    drop(found);
    let mut statement = db.prepare_cached(&sql(
        "pulsify_values",
        "clock",
        "o.sid,o.clock,o.dependencies,o.operations",
    ))?;
    bind(&mut statement)?;
    let mut found = statement.raw_query();
    while let Some(r) = found.next()? {
        hold(PatchRow {
            doc_id: doc_id.to_owned(),
            sid: r.get::<_, i64>(0)? as u64,
            clock: r.get::<_, i64>(1)? as u64,
            span: 1,
            dependencies: serde_json::from_str(&r.get::<_, String>(2)?)?,
            operations: r.get(3)?,
        });
    }
    drop(found);
    let mut rows = Vec::new();
    for (sid, frontier) in behind {
        let mut held = held.remove(&sid).unwrap_or_default();
        held.sort_by_key(|row| row.clock);
        serve(
            &mut rows,
            doc_id,
            sid,
            held,
            own_clock(remote, sid),
            frontier,
        );
    }
    Ok(rows)
}

/// The rows an actor still holds, sorted by clock, as a peer receives them:
/// each one's span runs to the next one, the last one's to the frontier. A
/// peer whose knowledge ends at `since` gets the row that holds it and those
/// after it, or a gap row up to the first one when no row holds it.
fn serve(
    rows: &mut Vec<PatchRow>,
    doc_id: &str,
    sid: u64,
    held: Vec<PatchRow>,
    since: u64,
    frontier: u64,
) {
    let from = since.max(1);
    let first = held.partition_point(|row| row.clock <= from);
    if first == 0 {
        let end = held.first().map_or(frontier, |row| row.clock);
        rows.push(PatchRow {
            doc_id: doc_id.to_owned(),
            sid,
            clock: from,
            span: end - from,
            dependencies: if from > 1 { vec![(sid, from)] } else { vec![] },
            operations: GAP_OPERATIONS.to_vec(),
        });
    }
    let ends: Vec<u64> = held
        .iter()
        .skip(1)
        .map(|row| row.clock)
        .chain([frontier])
        .collect();
    for (row, end) in held.into_iter().zip(ends).skip(first.saturating_sub(1)) {
        rows.push(PatchRow {
            span: end - row.clock,
            ..row
        });
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use pulsify_protocol::MAX_MESSAGE_ROWS;

    pub const A: u64 = 65536;
    pub const B: u64 = 65537;

    #[test]
    fn subtree_listing_uses_indexed_tombstone_checks() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let tx = store.db.transaction().unwrap();
        {
            let mut marker = tx
                .prepare("INSERT INTO pulsify_tombstones(prefix) VALUES(?)")
                .unwrap();
            let mut clock = tx
                .prepare("INSERT INTO pulsify_doc_clocks(doc_id,sid,clock) VALUES(?,?,2)")
                .unwrap();
            for i in 0..10_000 {
                marker.execute([format!("r/dead/{i}")]).unwrap();
            }
            for i in 0..100 {
                clock
                    .execute(params![format!("r/dead/{i}/child"), A as i64])
                    .unwrap();
            }
            for i in 0..2000 {
                for sid in [A, B] {
                    clock
                        .execute(params![format!("r/live/{i:04}"), sid as i64])
                        .unwrap();
                }
            }
        }
        tx.commit().unwrap();
        let started = std::time::Instant::now();
        let mut found = Vec::new();
        loop {
            let after = found.last().map(String::as_str).unwrap_or("");
            let page = store.documents("r", after, 128).unwrap();
            if page.is_empty() {
                break;
            }
            found.extend(page);
        }
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(
            found,
            (0..2000)
                .map(|i| format!("r/live/{i:04}"))
                .collect::<Vec<_>>()
        );
    }

    pub fn row(sid: u64, clock: u64, span: u64, dependencies: &[(u64, u64)]) -> PatchRow {
        PatchRow {
            doc_id: "doc".into(),
            sid,
            clock,
            span,
            dependencies: dependencies.to_vec(),
            operations: vec![sid as u8, clock as u8, span as u8],
        }
    }
    /// A contiguous segment of one actor, depending on its previous segment.
    pub fn next(sid: u64, clock: u64, span: u64) -> PatchRow {
        if clock == 1 {
            row(sid, 1, span, &[])
        } else {
            row(sid, clock, span, &[(sid, clock)])
        }
    }
    fn count(store: &SqliteStore, sql: &str) -> i64 {
        store.connection().query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn stores_and_reads_contiguous_rows() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let result = store
            .append(&[next(A, 1, 2), next(A, 3, 1), next(B, 1, 4)])
            .unwrap();
        assert_eq!(
            result,
            AppendResult {
                inserted: 3,
                ready: 3,
                pending: 0,
                vector: Some(vec![(A, 4), (B, 5)]),
            }
        );
        assert_eq!(store.vector("doc").unwrap(), vec![(A, 4), (B, 5)]);
        assert_eq!(store.missing("doc", &vec![]).unwrap().len(), 3);
        let missing = store.missing("doc", &vec![(A, 3)]).unwrap();
        assert_eq!(missing, vec![next(A, 3, 1), next(B, 1, 4)]);
        assert!(store
            .missing("doc", &vec![(A, 4), (B, 5)])
            .unwrap()
            .is_empty());
        assert!(store.missing("other", &vec![]).unwrap().is_empty());
        assert!(store.vector("other").unwrap().is_empty());
        let stored: String = store
            .connection()
            .query_row(
                "SELECT dependencies FROM pulsify_op_rows WHERE sid=? AND time_start=3",
                [A as i64],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, "[[65536,3]]");
    }

    fn varuint(out: &mut Vec<u8>, mut value: u64) {
        while value >= 128 {
            out.push((value % 128) as u8 | 128);
            value /= 128;
        }
        out.push(value as u8);
    }
    /// Folds every stored row of `sid` into one packed segment, as the
    /// TypeScript store does: a span runs to the next row.
    fn pack(store: &SqliteStore, sid: u64) {
        let db = store.connection();
        let rows: Vec<(u64, u64, String, Vec<u8>)> = db
            .prepare("SELECT time_start,span,dependencies,operations FROM pulsify_op_rows WHERE sid=? AND ready=1 ORDER BY time_start")
            .unwrap()
            .query_map([sid as i64], |r| {
                Ok((
                    r.get::<_, i64>(0)? as u64,
                    r.get::<_, i64>(1)? as u64,
                    r.get(2)?,
                    r.get(3)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let mut payload = Vec::new();
        for (index, (clock, span, dependencies, operations)) in rows.iter().enumerate() {
            let span = rows.get(index + 1).map_or(*span, |next| next.0 - clock);
            let dependencies: VersionVector = serde_json::from_str(dependencies).unwrap();
            varuint(&mut payload, span);
            varuint(&mut payload, dependencies.len() as u64);
            for (sid, clock) in &dependencies {
                varuint(&mut payload, *sid);
                varuint(&mut payload, *clock);
            }
            varuint(&mut payload, operations.len() as u64);
            payload.extend(operations);
        }
        let (first, last) = (&rows[0], rows.last().unwrap());
        db.execute(
            "DELETE FROM pulsify_op_rows WHERE sid=? AND time_start>? AND ready=1",
            params![sid as i64, first.0 as i64],
        )
        .unwrap();
        db.execute(
            "UPDATE pulsify_op_rows SET span=?,operations=?,packed=1 WHERE sid=? AND time_start=?",
            params![
                (last.0 + last.1 - first.0) as i64,
                payload,
                sid as i64,
                first.0 as i64
            ],
        )
        .unwrap();
    }

    #[test]
    fn packed_segments_read_and_check_like_their_rows() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let mut wide = row(A, 6, 1, &[(A, 6), (B, 2)]);
        wide.operations = (0..300u32).map(|byte| byte as u8).collect();
        let rows = vec![
            next(A, 1, 2),
            next(A, 3, 3),
            wide,
            next(A, 7, 1),
            next(B, 1, 4),
        ];
        store.append(&rows).unwrap();
        let remotes = [
            vec![],
            vec![(A, 2)],
            vec![(A, 3)],
            vec![(A, 4), (B, 9)],
            vec![(A, 7)],
            vec![(A, 8)],
        ];
        let expected: Vec<_> = remotes
            .iter()
            .map(|remote| store.missing("doc", remote).unwrap())
            .collect();
        pack(&store, A);
        assert_eq!(count(&store, "SELECT COUNT(*) FROM pulsify_op_rows"), 2);
        for (remote, expected) in remotes.iter().zip(&expected) {
            assert_eq!(&store.missing("doc", remote).unwrap(), expected);
        }
        assert_eq!(store.vector("doc").unwrap(), vec![(A, 8), (B, 5)]);
        // Resends of the first row of the segment and of rows inside it.
        assert_eq!(store.append(&rows).unwrap().inserted, 0);
        let mut changed_first = next(A, 1, 2);
        changed_first.operations = vec![9];
        let mut changed_inner = next(A, 7, 1);
        changed_inner.operations = vec![9];
        for (bad, message) in [
            (changed_first, "Conflicting storage segment"),
            (changed_inner, "Conflicting storage segment"),
            (next(A, 3, 2), "Conflicting storage segment"),
            (row(A, 8, 1, &[(A, 7)]), "Actor history fork"),
        ] {
            let error = store.append(&[bad]).unwrap_err();
            assert_eq!((error.code, error.message.as_str()), ("CONFLICT", message));
        }
        // A row that starts inside a row of the segment was replaced: ignored.
        assert_eq!(store.append(&[next(A, 4, 1)]).unwrap().inserted, 0);
        assert_eq!(count(&store, "SELECT COUNT(*) FROM pulsify_op_rows"), 2);
        assert_eq!(store.append(&[next(A, 8, 2)]).unwrap().ready, 1);
        assert_eq!(
            store.missing("doc", &vec![(A, 7), (B, 5)]).unwrap(),
            vec![next(A, 7, 1), next(A, 8, 2)]
        );
    }

    #[test]
    fn migrates_a_database_created_before_packed_segments() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(&SCHEMA.replace(" packed INTEGER NOT NULL DEFAULT 0,\n", ""))
            .unwrap();
        db.execute(
            "INSERT INTO pulsify_op_rows(doc_id,sid,time_start,span,dependencies,operations,ready) VALUES('doc',?,1,2,'[]',x'010203',1)",
            [A as i64],
        )
        .unwrap();
        db.execute(
            "INSERT INTO pulsify_doc_clocks VALUES('doc',?,3)",
            [A as i64],
        )
        .unwrap();
        let mut store = SqliteStore::new(db).unwrap();
        assert_eq!(store.missing("doc", &vec![]).unwrap().len(), 1);
        assert_eq!(store.append(&[next(A, 3, 1)]).unwrap().ready, 1);
        assert_eq!(
            count(
                &store,
                "SELECT COUNT(*) FROM pulsify_op_rows WHERE packed=0"
            ),
            2
        );
        // Opening it again changes nothing.
        let db = std::mem::replace(&mut store.db, Connection::open_in_memory().unwrap());
        assert_eq!(
            SqliteStore::new(db).unwrap().vector("doc").unwrap(),
            vec![(A, 4)]
        );
    }

    #[test]
    fn exact_duplicates_are_idempotent() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        store.append(&[next(A, 1, 2)]).unwrap();
        let again = store.append(&[next(A, 1, 2), next(A, 1, 2)]).unwrap();
        assert_eq!(again.inserted, 0);
        assert_eq!(count(&store, "SELECT COUNT(*) FROM pulsify_op_rows"), 1);
        assert_eq!(store.append(&[]).unwrap(), AppendResult::default());
    }

    #[test]
    fn conflicts_roll_back_the_whole_batch() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        store.append(&[next(A, 1, 2)]).unwrap();
        let mut changed = next(A, 1, 2);
        changed.operations = vec![9];
        let cases = [
            (changed, "Conflicting storage segment"),
            (row(A, 3, 1, &[(A, 2)]), "Actor history fork"),
        ];
        for (bad, message) in cases {
            let error = store.append(&[next(B, 1, 1), bad]).unwrap_err();
            assert_eq!((error.code, error.message.as_str()), ("CONFLICT", message));
            assert_eq!(count(&store, "SELECT COUNT(*) FROM pulsify_op_rows"), 1);
            assert_eq!(store.vector("doc").unwrap(), vec![(A, 3)]);
        }
        // Forks are detected against later neighbours and rows of the same batch.
        store.append(&[row(A, 5, 1, &[(A, 3)])]).unwrap();
        let error = store.append(&[next(A, 3, 2)]).unwrap_err();
        assert_eq!(error.message, "Actor history fork");
        let error = store
            .append(&[next(A, 6, 1), row(A, 7, 1, &[(A, 4)])])
            .unwrap_err();
        assert_eq!(error.message, "Actor history fork");
        assert_eq!(count(&store, "SELECT COUNT(*) FROM pulsify_op_rows"), 2);
    }

    #[test]
    fn gaps_and_missing_dependencies_stay_pending_until_promoted() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let gap = store.append(&[next(A, 3, 2)]).unwrap();
        assert_eq!((gap.inserted, gap.ready, gap.pending), (1, 0, 1));
        let dependent = store.append(&[row(B, 1, 1, &[(A, 5)])]).unwrap();
        assert_eq!((dependent.ready, dependent.pending), (0, 2));
        assert!(store.vector("doc").unwrap().is_empty());
        assert!(store.missing("doc", &vec![]).unwrap().is_empty());
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM pulsify_dangling_op_rows"),
            2
        );
        let filled = store.append(&[next(A, 1, 2)]).unwrap();
        assert_eq!((filled.inserted, filled.ready, filled.pending), (1, 3, 0));
        assert_eq!(store.vector("doc").unwrap(), vec![(A, 5), (B, 2)]);
        assert_eq!(
            store.missing("doc", &vec![]).unwrap(),
            vec![next(A, 1, 2), next(A, 3, 2), row(B, 1, 1, &[(A, 5)])]
        );
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM pulsify_op_rows WHERE ready=0"),
            0
        );
    }

    #[test]
    fn in_order_rows_skip_pending_and_keep_every_check() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let batch: Vec<_> = (1..=5).map(|clock| next(A, clock, 1)).collect();
        let result = store.append(&batch).unwrap();
        assert_eq!((result.inserted, result.ready), (5, 5));
        assert_eq!(result.vector, Some(vec![(A, 6)]));
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM pulsify_op_rows WHERE ready=0"),
            0
        );
        // Resends stay idempotent, a different payload conflicts.
        assert_eq!(store.append(&batch[1..3]).unwrap().inserted, 0);
        let mut changed = next(A, 3, 1);
        changed.operations.push(0);
        let error = store.append(&[changed]).unwrap_err();
        assert_eq!(error.message, "Conflicting storage segment");
        // A fork at the frontier is caught without reading the previous row,
        // and rolls back the whole batch.
        for fork in [row(A, 6, 1, &[]), row(A, 6, 1, &[(A, 5)])] {
            let error = store.append(&[next(B, 1, 1), fork]).unwrap_err();
            assert_eq!(error.message, "Actor history fork");
        }
        assert_eq!(store.vector("doc").unwrap(), vec![(A, 6)]);
        // In-order rows of A while B has a pending row; an overlap with it conflicts.
        store.append(&[next(B, 3, 1)]).unwrap();
        let both = store.append(&[next(A, 6, 1), next(B, 1, 2)]).unwrap();
        assert_eq!((both.ready, both.pending), (3, 0));
        assert_eq!(both.vector, Some(vec![(A, 7), (B, 4)]));
        // A row whose span covers a waiting row replaces it.
        store.append(&[next(B, 6, 1)]).unwrap();
        let wide = store.append(&[next(B, 4, 3)]).unwrap();
        assert_eq!((wide.inserted, wide.ready, wide.pending), (1, 1, 0));
        assert_eq!(wide.vector, Some(vec![(A, 7), (B, 7)]));
        assert_eq!(
            store.missing("doc", &vec![(A, 7), (B, 4)]).unwrap(),
            vec![next(B, 4, 3)]
        );
    }

    /// One kind 7 write of `sid` to the numeric field `field` of the node "n":
    /// a last-value row.
    pub fn write(sid: u64, clock: u64, lamport: u8, field: u8) -> PatchRow {
        PatchRow {
            operations: vec![
                3,
                lamport,
                0,
                1,
                7,
                1,
                b'n',
                1,
                field,
                sid as u8,
                clock as u8,
            ],
            ..next(sid, clock, 1)
        }
    }
    /// What stays of replaced writes that no earlier row can cover.
    pub fn gap(sid: u64, clock: u64, span: u64) -> PatchRow {
        PatchRow {
            operations: GAP_OPERATIONS.to_vec(),
            ..next(sid, clock, span)
        }
    }
    /// The ready rows of "doc": actor, start and span.
    fn spans(store: &SqliteStore) -> Vec<(u64, u64, u64)> {
        store
            .missing("doc", &vec![])
            .unwrap()
            .iter()
            .map(|row| (row.sid, row.clock, row.span))
            .collect()
    }
    /// The values: actor, field, then the clock of the write that holds it.
    fn values(store: &SqliteStore) -> Vec<(u64, u8, u64)> {
        store
            .connection()
            .prepare("SELECT sid,register,clock FROM pulsify_values WHERE doc_id='doc' ORDER BY sid,register")
            .unwrap()
            .query_map([], |r| {
                let register: Vec<u8> = r.get(1)?;
                assert_eq!(register[..3], [1, b'n', 1]);
                Ok((r.get::<_, i64>(0)? as u64, register[3], r.get::<_, i64>(2)? as u64))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }
    fn changes(store: &SqliteStore) -> i64 {
        count(store, "SELECT total_changes()")
    }

    #[test]
    fn a_register_rewritten_many_times_keeps_one_row_per_actor() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        store.append(&[next(A, 1, 1), next(B, 1, 1)]).unwrap();
        for clock in 2..=300u64 {
            // Two registers of A, one of which B also writes, with older times.
            let before = changes(&store);
            let mine = store
                .append(&[write(A, clock, 100, (clock % 2) as u8)])
                .unwrap();
            assert_eq!((mine.inserted, mine.ready, mine.pending), (1, 1, 0));
            let late = store.append(&[write(B, clock, 1, 0)]).unwrap();
            assert_eq!((late.inserted, late.ready), (1, 1));
            assert_eq!(late.vector, Some(vec![(A, clock + 1), (B, clock + 1)]));
            // A value and a clock per write.
            assert_eq!(changes(&store) - before, 4);
        }
        // Each actor keeps its first row and its last write to each register,
        // whatever the other actor wrote: replicas pick the winner.
        assert_eq!(
            spans(&store),
            vec![
                (A, 1, 298),
                (A, 299, 1),
                (A, 300, 1),
                (B, 1, 299),
                (B, 300, 1)
            ]
        );
        assert_eq!(count(&store, "SELECT COUNT(*) FROM pulsify_op_rows"), 2);
        assert_eq!(values(&store), vec![(A, 0, 300), (A, 1, 299), (B, 0, 300)]);
        assert_eq!(
            store.missing("doc", &vec![(A, 299), (B, 301)]).unwrap(),
            vec![write(A, 299, 100, 1), write(A, 300, 100, 0)]
        );
        // Sent again, whole or with the spans a peer holds, nothing changes.
        let mut again = store.missing("doc", &vec![]).unwrap();
        again.extend((2..=300).map(|clock| write(A, clock, 100, (clock % 2) as u8)));
        assert_eq!(store.append(&again).unwrap().inserted, 0);
        assert_eq!(count(&store, "SELECT COUNT(*) FROM pulsify_values"), 3);
        // A newer write of the same actor overwrites its value in place.
        store.append(&[write(B, 301, 100, 0)]).unwrap();
        store.append(&[write(A, 301, 100, 0)]).unwrap();
        assert_eq!(values(&store), vec![(A, 0, 301), (A, 1, 299), (B, 0, 301)]);
        assert_eq!(
            spans(&store),
            vec![
                (A, 1, 298),
                (A, 299, 2),
                (A, 301, 1),
                (B, 1, 300),
                (B, 301, 1)
            ]
        );
    }

    #[test]
    fn every_actor_keeps_its_own_last_write() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        store.append(&[next(A, 1, 1), write(A, 2, 9, 0)]).unwrap();
        // An older write of another actor is kept: it is that actor's last one.
        let late = store.append(&[next(B, 1, 1), write(B, 2, 3, 0)]).unwrap();
        assert_eq!((late.inserted, late.ready, late.pending), (2, 2, 0));
        assert_eq!(
            spans(&store),
            vec![(A, 1, 1), (A, 2, 1), (B, 1, 1), (B, 2, 1)]
        );
        // On promotion: it waited for the row before it, and replaces B's value.
        let waiting = store.append(&[write(B, 4, 4, 0), next(B, 5, 1)]).unwrap();
        assert_eq!((waiting.ready, waiting.pending), (0, 2));
        let filled = store.append(&[next(B, 3, 1)]).unwrap();
        assert_eq!((filled.inserted, filled.ready, filled.pending), (1, 3, 0));
        assert_eq!(
            spans(&store),
            vec![
                (A, 1, 1),
                (A, 2, 1),
                (B, 1, 2),
                (B, 3, 1),
                (B, 4, 1),
                (B, 5, 1)
            ]
        );
        assert_eq!(values(&store), vec![(A, 0, 2), (B, 0, 4)]);
        store.append(&[write(B, 6, 10, 0)]).unwrap();
        assert_eq!(
            spans(&store),
            vec![
                (A, 1, 1),
                (A, 2, 1),
                (B, 1, 2),
                (B, 3, 2),
                (B, 5, 1),
                (B, 6, 1)
            ]
        );
        assert_eq!(values(&store), vec![(A, 0, 2), (B, 0, 6)]);
        assert_eq!(store.vector("doc").unwrap(), vec![(A, 3), (B, 7)]);
        // Other kinds and transactions of several operations are history: kept.
        let mut kept = write(A, 3, 50, 0);
        kept.operations[3] = 2;
        let mut plain = write(A, 4, 50, 0);
        plain.operations[4] = 1;
        store.append(&[kept, plain]).unwrap();
        assert_eq!(count(&store, "SELECT COUNT(*) FROM pulsify_op_rows"), 6);
        assert_eq!(values(&store), vec![(A, 0, 2), (B, 0, 6)]);
    }

    #[test]
    fn replaced_writes_are_served_as_spans_and_gap_rows() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        store.append(&[write(A, 1, 1, 0)]).unwrap();
        store.append(&[write(B, 1, 2, 0)]).unwrap();
        assert_eq!(
            store.missing("doc", &vec![]).unwrap(),
            vec![write(A, 1, 1, 0), write(B, 1, 2, 0)]
        );
        // Nothing holds A's first sequence numbers any more: a gap row stands
        // for them, depending on what came before it.
        store
            .append(&[write(A, 2, 1, 0), write(A, 3, 1, 0)])
            .unwrap();
        assert_eq!(
            store.missing("doc", &vec![(B, 2)]).unwrap(),
            vec![gap(A, 1, 2), write(A, 3, 1, 0)]
        );
        assert_eq!(
            store.missing("doc", &vec![(A, 2), (B, 2)]).unwrap(),
            vec![gap(A, 2, 1), write(A, 3, 1, 0)]
        );
        assert_eq!(count(&store, "SELECT COUNT(*) FROM pulsify_op_rows"), 0);
        // A peer sends a gap row where this store holds a row, and the reverse:
        // neither is a conflict, and the row that is held stays.
        let result = store.append(&[gap(B, 1, 1), write(A, 1, 1, 0)]).unwrap();
        assert_eq!(result.inserted, 0);
        // A gap row that arrives only moves the frontier.
        let before = changes(&store);
        store.append(&[gap(B, 2, 3), gap(A + 2, 1, 2)]).unwrap();
        assert_eq!(changes(&store) - before, 2);
        assert_eq!(
            spans(&store),
            vec![(A, 1, 2), (A, 3, 1), (B, 1, 4), (A + 2, 1, 2)]
        );
        assert_eq!(
            store.vector("doc").unwrap(),
            vec![(A, 4), (B, 5), (A + 2, 3)]
        );
        // A hole between history rows, and values beside a packed segment.
        store
            .append(&[next(B, 5, 1), write(B, 6, 3, 1), next(B, 7, 1)])
            .unwrap();
        store.append(&[write(B, 8, 4, 1), next(B, 9, 1)]).unwrap();
        let remotes = [
            vec![],
            vec![(B, 6)],
            vec![(B, 7)],
            vec![(B, 8)],
            vec![(B, 9)],
        ];
        let expected: Vec<_> = remotes
            .iter()
            .map(|remote| store.missing("doc", remote).unwrap())
            .collect();
        assert_eq!(
            expected[2]
                .iter()
                .filter(|row| row.sid == B)
                .collect::<Vec<_>>(),
            vec![&next(B, 7, 1), &write(B, 8, 4, 1), &next(B, 9, 1)]
        );
        assert_eq!(
            expected[1]
                .iter()
                .filter(|row| row.sid == B)
                .collect::<Vec<_>>(),
            vec![
                &PatchRow {
                    span: 2,
                    ..next(B, 5, 1)
                },
                &next(B, 7, 1),
                &write(B, 8, 4, 1),
                &next(B, 9, 1)
            ]
        );
        pack(&store, B);
        assert_eq!(
            count(
                &store,
                "SELECT COUNT(*) FROM pulsify_op_rows WHERE packed=1"
            ),
            1
        );
        for (remote, expected) in remotes.iter().zip(&expected) {
            assert_eq!(&store.missing("doc", remote).unwrap(), expected);
        }
        let changed = PatchRow {
            operations: vec![9],
            ..next(B, 7, 1)
        };
        let error = store.append(&[changed]).unwrap_err();
        assert_eq!(error.message, "Conflicting storage segment");
        assert_eq!(values(&store), vec![(A, 0, 3), (B, 0, 1), (B, 1, 8)]);
    }

    #[test]
    fn other_contents_at_a_stored_identity_still_conflict() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        store
            .append(&[next(A, 1, 1), write(A, 2, 5, 0), next(A, 5, 2)])
            .unwrap();
        let changed = |mut row: PatchRow| {
            row.operations.push(1);
            row
        };
        for bad in [
            // A ready row, a last-value row and a row that waits, whatever the span.
            changed(next(A, 1, 1)),
            changed(next(A, 1, 4)),
            changed(write(A, 2, 5, 0)),
            changed(next(A, 2, 1)),
            changed(next(A, 5, 2)),
            changed(next(A, 5, 9)),
        ] {
            let error = store.append(&[next(B, 1, 1), bad]).unwrap_err();
            assert_eq!(
                (error.code, error.message.as_str()),
                ("CONFLICT", "Conflicting storage segment")
            );
        }
        assert_eq!(store.vector("doc").unwrap(), vec![(A, 3)]);
        assert_eq!(count(&store, "SELECT COUNT(*) FROM pulsify_op_rows"), 2);
        assert_eq!(values(&store), vec![(A, 0, 2)]);
        // Once replaced, a row is no longer compared: its sequence number holds nothing.
        store.append(&[write(A, 3, 6, 0)]).unwrap();
        assert_eq!(spans(&store), vec![(A, 1, 2), (A, 3, 1)]);
        assert_eq!(
            store
                .append(&[changed(write(A, 2, 5, 0))])
                .unwrap()
                .inserted,
            0
        );
        let error = store.append(&[changed(next(A, 1, 2))]).unwrap_err();
        assert_eq!(error.code, "CONFLICT");
    }

    #[test]
    fn opens_a_database_created_before_fields_without_history() {
        let db = Connection::open_in_memory().unwrap();
        let old = SCHEMA
            .split("CREATE TABLE IF NOT EXISTS pulsify_values")
            .next()
            .unwrap();
        db.execute_batch(old).unwrap();
        db.execute(
            "INSERT INTO pulsify_op_rows(doc_id,sid,time_start,span,dependencies,operations,ready) VALUES('doc',?,1,1,'[]',x'010203',1)",
            [A as i64],
        )
        .unwrap();
        db.execute(
            "INSERT INTO pulsify_doc_clocks VALUES('doc',?,2)",
            [A as i64],
        )
        .unwrap();
        // Its rows are history rows.
        let mut store = SqliteStore::new(db).unwrap();
        store
            .append(&[write(A, 2, 1, 0), write(A, 3, 2, 0)])
            .unwrap();
        assert_eq!(spans(&store), vec![(A, 1, 2), (A, 3, 1)]);
        assert_eq!(values(&store), vec![(A, 0, 3)]);
    }

    #[test]
    fn moves_the_rows_of_the_register_index_to_values() {
        // The unreleased layout: one row per register, indexed, spans grown
        // over replaced writes, and gap rows where no row could grow.
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(&format!(
            "{}CREATE TABLE pulsify_registers (
 doc_id TEXT NOT NULL, register BLOB NOT NULL, sid INTEGER NOT NULL, clock INTEGER NOT NULL,
 lamport INTEGER NOT NULL,
 PRIMARY KEY(doc_id, register)
) WITHOUT ROWID;",
            SCHEMA
                .split("CREATE TABLE IF NOT EXISTS pulsify_values")
                .next()
                .unwrap()
        ))
        .unwrap();
        let insert = |row: &PatchRow, ready: bool| {
            db.execute(
                "INSERT INTO pulsify_op_rows(doc_id,sid,time_start,span,dependencies,operations,ready) VALUES('doc',?,?,?,?,?,?)",
                params![
                    row.sid as i64,
                    row.clock as i64,
                    row.span as i64,
                    serde_json::to_string(&row.dependencies).unwrap(),
                    row.operations,
                    ready
                ],
            )
            .unwrap();
        };
        let a3 = write(A, 3, 5, 0);
        let b2 = write(B, 2, 7, 1);
        for row in [next(A, 1, 2), a3.clone(), gap(B, 1, 1), b2.clone()] {
            insert(&row, true);
        }
        insert(&gap(B, 5, 1), false);
        for (row, lamport) in [(&a3, 5), (&b2, 7)] {
            db.execute(
                "INSERT INTO pulsify_registers VALUES('doc',?,?,?,?)",
                params![
                    last_register_of(&row.operations).unwrap().register,
                    row.sid as i64,
                    row.clock as i64,
                    lamport
                ],
            )
            .unwrap();
        }
        db.execute_batch(&format!(
            "INSERT INTO pulsify_doc_clocks VALUES('doc',{A},4),('doc',{B},3);"
        ))
        .unwrap();
        let mut store = SqliteStore::new(db).unwrap();
        assert_eq!(
            count(
                &store,
                "SELECT COUNT(*) FROM sqlite_master WHERE name='pulsify_registers'"
            ),
            0
        );
        assert_eq!(values(&store), vec![(A, 0, 3), (B, 1, 2)]);
        // The waiting gap row stays; the ready one is a hole now.
        assert_eq!(count(&store, "SELECT COUNT(*) FROM pulsify_op_rows"), 2);
        assert_eq!(
            store.missing("doc", &vec![]).unwrap(),
            vec![next(A, 1, 2), a3, gap(B, 1, 1), b2]
        );
        let result = store.append(&[next(B, 3, 2), write(A, 4, 6, 0)]).unwrap();
        assert_eq!((result.ready, result.pending), (3, 0));
        assert_eq!(values(&store), vec![(A, 0, 4), (B, 1, 2)]);
        assert_eq!(
            spans(&store),
            vec![(A, 1, 3), (A, 4, 1), (B, 1, 1), (B, 2, 1), (B, 3, 3)]
        );
    }

    #[test]
    fn rejects_invalid_rows_and_documents() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let mut other_doc = next(B, 1, 1);
        other_doc.doc_id = "other".into();
        let mut empty = next(A, 1, 1);
        empty.operations.clear();
        for rows in [
            vec![next(A, 1, 1), other_doc],
            vec![row(1, 1, 1, &[])],
            vec![row(A, 0, 1, &[])],
            vec![row(A, 1, 0, &[])],
            vec![row(A, 2, 1, &[(A, 3)])],
            vec![row(A, 1, 1, &[(B, 1), (A, 1)])],
            vec![empty],
        ] {
            assert_eq!(store.append(&rows).unwrap_err().code, "INVALID_MESSAGE");
        }
        let too_many: Vec<_> = (1..=MAX_MESSAGE_ROWS as u64 + 1)
            .map(|clock| next(A, clock, 1))
            .collect();
        assert_eq!(store.append(&too_many).unwrap_err().code, "LIMIT_EXCEEDED");
        assert_eq!(store.vector("").unwrap_err().code, "INVALID_MESSAGE");
        assert_eq!(store.vector("a\0b").unwrap_err().code, "INVALID_MESSAGE");
        assert_eq!(
            store.vector(&"x".repeat(1025)).unwrap_err().code,
            "INVALID_MESSAGE"
        );
        assert_eq!(
            store
                .missing("doc", &vec![(B, 1), (A, 1)])
                .unwrap_err()
                .code,
            "INVALID_MESSAGE"
        );
        assert_eq!(count(&store, "SELECT COUNT(*) FROM pulsify_op_rows"), 0);
    }

    #[test]
    fn limits_the_number_of_actors() {
        let mut store = SqliteStore::open_in_memory().unwrap();
        let rows: Vec<_> = (0..MAX_VECTOR_ENTRIES as u64)
            .map(|i| next(A + i, 1, 1))
            .collect();
        store.append(&rows).unwrap();
        let error = store
            .append(&[next(A + MAX_VECTOR_ENTRIES as u64, 2, 1)])
            .unwrap_err();
        assert_eq!(error.code, "LIMIT_EXCEEDED");
        assert_eq!(store.vector("doc").unwrap().len(), MAX_VECTOR_ENTRIES);
        assert_eq!(
            count(&store, "SELECT COUNT(*) FROM pulsify_op_rows"),
            MAX_VECTOR_ENTRIES as i64
        );
    }

    #[test]
    fn persists_across_reopen() {
        let path = std::env::temp_dir().join(format!(
            "pulsify-sqlite-{}-{:?}.sqlite",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_file(&path);
        {
            let mut store = SqliteStore::open(&path).unwrap();
            store.append(&[next(A, 1, 3), next(A, 5, 1)]).unwrap();
        }
        let mut store = SqliteStore::open(&path).unwrap();
        assert_eq!(store.vector("doc").unwrap(), vec![(A, 4)]);
        assert_eq!(store.append(&[next(A, 4, 1)]).unwrap().ready, 2);
        let (rows, vector) = store.sync_state("doc", &vec![(A, 4)]).unwrap();
        assert_eq!(vector, vec![(A, 6)]);
        assert_eq!(rows, vec![next(A, 4, 1), next(A, 5, 1)]);
        drop(store);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }
}
