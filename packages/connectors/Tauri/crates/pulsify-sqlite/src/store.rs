use crate::{Error, Result};
use pulsify_protocol::{
    validate_vector, PatchRow, VersionVector, MAX_MESSAGE_ROWS, MAX_PATCH_BYTES, MAX_SAFE_INTEGER,
    MAX_VECTOR_ENTRIES,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::Duration;

/// Byte-for-byte `SQLITE_PATCH_SCHEMA` from `pulsify-core/storage`.
pub const SCHEMA: &str = "
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
";

/// Byte-for-byte `SQLITE_PACKED_MIGRATION`: added to a table created before packed segments.
pub const PACKED_MIGRATION: &str =
    "ALTER TABLE pulsify_op_rows ADD COLUMN packed INTEGER NOT NULL DEFAULT 0";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AppendResult {
    pub inserted: usize,
    pub ready: usize,
    pub pending: usize,
}

/// Immutable rows keyed by `(doc_id, sid, time_start)`. Rows stay pending until
/// their actor prefix is contiguous and their dependencies are stored.
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
    pub fn new(db: Connection) -> Result<Self> {
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
        Ok(Self { db })
    }
    pub fn connection(&self) -> &Connection {
        &self.db
    }

    /// Validates and stores rows of one document in one IMMEDIATE transaction.
    /// Exact retransmissions are ignored; a conflict rolls back the whole batch.
    pub fn append(&mut self, rows: &[PatchRow]) -> Result<AppendResult> {
        let Some(doc_id) = validate_rows(rows)? else {
            return Ok(AppendResult::default());
        };
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = append_rows(&tx, doc_id, rows)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn vector(&self, doc_id: &str) -> Result<VersionVector> {
        validate_doc_id(doc_id)?;
        read_vector(&self.db, doc_id)
    }

    /// Ready rows the peer lacks, ordered by actor and clock.
    pub fn missing(&self, doc_id: &str, remote: &VersionVector) -> Result<Vec<PatchRow>> {
        validate_doc_id(doc_id)?;
        validate_vector(remote)?;
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
        let rows = read_missing(&tx, doc_id, remote)?;
        let vector = read_vector(&tx, doc_id)?;
        tx.commit()?;
        Ok((rows, vector))
    }
}

pub fn validate_doc_id(doc_id: &str) -> Result<()> {
    if doc_id.is_empty() || doc_id.contains('\0') || doc_id.encode_utf16().count() > 1024 {
        return Err(Error::new("INVALID_MESSAGE", "Invalid document ID"));
    }
    Ok(())
}

fn validate_rows(rows: &[PatchRow]) -> Result<Option<&str>> {
    if rows.len() > MAX_MESSAGE_ROWS {
        return Err(Error::new("LIMIT_EXCEEDED", "Too many patch rows"));
    }
    let Some(first) = rows.first() else {
        return Ok(None);
    };
    let doc_id = first.doc_id.as_str();
    validate_doc_id(doc_id)?;
    for row in rows {
        validate_vector(&row.dependencies)?;
        if row.doc_id != doc_id
            || row.sid < 65536
            || row.sid > MAX_SAFE_INTEGER
            || row.clock < 1
            || row.span < 1
            || row.clock.saturating_add(row.span) > MAX_SAFE_INTEGER
            || row.operations.is_empty()
            || row.operations.len() > MAX_PATCH_BYTES
            || own_clock(&row.dependencies, row.sid) > row.clock
        {
            return Err(Error::new("INVALID_MESSAGE", "Invalid storage segment"));
        }
    }
    Ok(Some(doc_id))
}

fn own_clock(vv: &VersionVector, sid: u64) -> u64 {
    vv.iter()
        .find(|(id, _)| *id == sid)
        .map_or(0, |(_, clock)| *clock)
}

fn conflict(message: &str) -> Error {
    Error::new("CONFLICT", message)
}

/// The stored envelope of a neighbouring segment of the same actor.
struct Segment {
    clock: u64,
    span: u64,
    dependencies: VersionVector,
}

fn assert_compatible(row: &PatchRow, other: &Segment) -> Result<()> {
    if row.clock < other.clock + other.span && other.clock < row.clock + row.span {
        return Err(conflict("Overlapping immutable storage segments"));
    }
    let (previous_end, next_dependency) = if row.clock < other.clock {
        (
            row.clock + row.span,
            own_clock(&other.dependencies, row.sid),
        )
    } else {
        (
            other.clock + other.span,
            own_clock(&row.dependencies, row.sid),
        )
    };
    if next_dependency < previous_end {
        return Err(conflict("Actor history fork"));
    }
    Ok(())
}

fn corrupt() -> Error {
    Error::new("CONNECTION_FAILED", "Corrupt packed segment")
}

/// The rows of a packed segment, as `SqlitePatchStore.compact` folded them:
/// for each, `span`, the dependencies and the operation bytes, numbers as
/// LEB128 varuints. They are contiguous from the segment's clock to its end.
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

fn same_row(stored: &PatchRow, row: &PatchRow) -> bool {
    stored.span == row.span
        && stored.dependencies == row.dependencies
        && stored.operations == row.operations
}

fn append_rows(tx: &Transaction<'_>, doc_id: &str, rows: &[PatchRow]) -> Result<AppendResult> {
    let mut get = tx.prepare_cached(
        "SELECT span,dependencies,operations,packed FROM pulsify_op_rows WHERE doc_id=?1 AND sid=?2 AND time_start=?3",
    )?;
    let mut neighbours = tx.prepare_cached(
        "SELECT time_start,span,dependencies,packed FROM pulsify_op_rows WHERE doc_id=?1 AND sid=?2 AND
 (time_start=(SELECT MAX(time_start) FROM pulsify_op_rows WHERE doc_id=?1 AND sid=?2 AND time_start<?3)
 OR time_start=(SELECT MIN(time_start) FROM pulsify_op_rows WHERE doc_id=?1 AND sid=?2 AND time_start>?3))",
    )?;
    let mut insert = tx.prepare_cached(
        "INSERT INTO pulsify_op_rows(doc_id,sid,time_start,span,dependencies,operations) VALUES(?,?,?,?,?,?)",
    )?;
    let mut inserted = 0;
    'rows: for row in rows {
        let (sid, clock) = (row.sid as i64, row.clock as i64);
        // The stored row at a key: itself, or the rows packed inside it.
        let mut stored = |start: i64| -> Result<Option<Vec<PatchRow>>> {
            let Some((span, dependencies, operations, packed)) = get
                .query_row(params![doc_id, sid, start], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Vec<u8>>(2)?,
                        r.get::<_, bool>(3)?,
                    ))
                })
                .optional()?
            else {
                return Ok(None);
            };
            Ok(Some(if packed {
                unpack(doc_id, row.sid, start as u64, span as u64, &operations)?
            } else {
                vec![PatchRow {
                    doc_id: doc_id.to_owned(),
                    sid: row.sid,
                    clock: start as u64,
                    span: span as u64,
                    dependencies: serde_json::from_str(&dependencies)?,
                    operations,
                }]
            }))
        };
        if let Some(existing) = stored(clock)? {
            // A packed segment starts with the row that had its key.
            if !same_row(&existing[0], row) {
                return Err(conflict("Conflicting storage segment"));
            }
            continue;
        }
        let found = neighbours
            .query_map(params![doc_id, sid, clock], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, bool>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (start, span, dependencies, packed) in found {
            let mut segment = Segment {
                clock: start as u64,
                span: span as u64,
                dependencies: serde_json::from_str(&dependencies)?,
            };
            // Seen from outside, a packed segment checks like its rows. A row
            // that starts inside is compared to the row it hits.
            if packed && segment.clock < row.clock && row.clock < segment.clock + segment.span {
                let inner = stored(start)?.ok_or_else(corrupt)?;
                if let Some(same) = inner.iter().find(|each| each.clock == row.clock) {
                    if !same_row(same, row) {
                        return Err(conflict("Conflicting storage segment"));
                    }
                    continue 'rows;
                }
                let hit = inner
                    .into_iter()
                    .rev()
                    .find(|each| each.clock < row.clock)
                    .ok_or_else(corrupt)?;
                segment = Segment {
                    clock: hit.clock,
                    span: hit.span,
                    dependencies: hit.dependencies,
                };
            }
            assert_compatible(row, &segment)?;
        }
        insert.execute(params![
            doc_id,
            sid,
            clock,
            row.span as i64,
            serde_json::to_string(&row.dependencies)?,
            row.operations,
        ])?;
        inserted += 1;
    }
    let mut frontier: BTreeMap<u64, u64> = read_vector(tx, doc_id)?.into_iter().collect();
    let mut pending = tx
        .prepare_cached(
            "SELECT sid,time_start,time_end,dependencies FROM pulsify_op_rows WHERE doc_id=? AND ready=0 ORDER BY sid,time_start",
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
            Ok((sid, start, end, serde_json::from_str(&dependencies)?))
        })
        .collect::<Result<Vec<(u64, u64, u64, VersionVector)>>>()?;
    let actors: BTreeSet<u64> = frontier
        .keys()
        .copied()
        .chain(pending.iter().map(|row| row.0))
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
    let mut ready = 0;
    let mut changed_actors = BTreeSet::new();
    loop {
        let mut changed = false;
        let mut waiting = Vec::new();
        for row in pending {
            let (sid, start, end, ref dependencies) = row;
            let contiguous = start == frontier.get(&sid).copied().unwrap_or(1);
            let covered = dependencies
                .iter()
                .all(|(actor, clock)| frontier.get(actor).copied().unwrap_or(0) >= *clock);
            if !contiguous || !covered {
                waiting.push(row);
                continue;
            }
            promote.execute(params![doc_id, sid as i64, start as i64])?;
            let clock = frontier.entry(sid).or_insert(0);
            *clock = (*clock).max(end);
            changed_actors.insert(sid);
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

fn read_missing(db: &Connection, doc_id: &str, remote: &VersionVector) -> Result<Vec<PatchRow>> {
    let map = |r: &rusqlite::Row<'_>| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, Vec<u8>>(4)?,
            r.get::<_, bool>(5)?,
        ))
    };
    let found = if remote.is_empty() {
        db.prepare_cached(
            "SELECT sid,time_start,span,dependencies,operations,packed FROM pulsify_op_rows WHERE doc_id=? AND ready=1 ORDER BY sid,time_start",
        )?
        .query_map([doc_id], map)?
        .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        // Same primary key seek per behind actor as `SqlitePatchStore.missing`.
        db.prepare_cached(
            "WITH remote(sid,clock) AS (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?1)),
 actors(sid,since) AS (SELECT c.sid,COALESCE(r.clock,0) FROM pulsify_doc_clocks c LEFT JOIN remote r ON r.sid=c.sid
  WHERE c.doc_id=?2 AND c.clock>COALESCE(r.clock,0))
 SELECT o.sid,o.time_start,o.span,o.dependencies,o.operations,o.packed FROM actors a CROSS JOIN pulsify_op_rows o WHERE o.doc_id=?2 AND o.sid=a.sid
 AND o.time_start>=COALESCE((SELECT MAX(time_start) FROM pulsify_op_rows WHERE doc_id=?2 AND sid=a.sid AND time_start<=a.since),0)
 AND o.ready=1 AND o.time_end>a.since ORDER BY o.sid,o.time_start",
        )?
        .query_map(params![serde_json::to_string(remote)?, doc_id], map)?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut rows = Vec::with_capacity(found.len());
    for (sid, clock, span, dependencies, operations, packed) in found {
        let (sid, clock, span) = (sid as u64, clock as u64, span as u64);
        if packed {
            // Packed segments never reach a peer: it gets the rows inside.
            let since = own_clock(remote, sid);
            rows.extend(
                unpack(doc_id, sid, clock, span, &operations)?
                    .into_iter()
                    .filter(|inner| inner.end() > since),
            );
        } else {
            rows.push(PatchRow {
                doc_id: doc_id.to_owned(),
                sid,
                clock,
                span,
                dependencies: serde_json::from_str(&dependencies)?,
                operations,
            });
        }
    }
    Ok(rows)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub const A: u64 = 65536;
    pub const B: u64 = 65537;

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
                pending: 0
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
    /// Folds every row of `sid` into one packed segment, as the TypeScript store does.
    fn pack(store: &SqliteStore, sid: u64) {
        let rows: Vec<_> = store
            .missing("doc", &vec![])
            .unwrap()
            .into_iter()
            .filter(|row| row.sid == sid)
            .collect();
        let mut payload = Vec::new();
        for row in &rows {
            varuint(&mut payload, row.span);
            varuint(&mut payload, row.dependencies.len() as u64);
            for (sid, clock) in &row.dependencies {
                varuint(&mut payload, *sid);
                varuint(&mut payload, *clock);
            }
            varuint(&mut payload, row.operations.len() as u64);
            payload.extend(&row.operations);
        }
        let (first, last) = (&rows[0], rows.last().unwrap());
        let db = store.connection();
        db.execute(
            "DELETE FROM pulsify_op_rows WHERE sid=? AND time_start>?",
            params![sid as i64, first.clock as i64],
        )
        .unwrap();
        db.execute(
            "UPDATE pulsify_op_rows SET span=?,operations=?,packed=1 WHERE sid=?",
            params![(last.end() - first.clock) as i64, payload, sid as i64],
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
            (next(A, 4, 1), "Overlapping immutable storage segments"),
            (row(A, 8, 1, &[(A, 7)]), "Actor history fork"),
        ] {
            let error = store.append(&[bad]).unwrap_err();
            assert_eq!((error.code, error.message.as_str()), ("CONFLICT", message));
        }
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
            (next(A, 2, 2), "Overlapping immutable storage segments"),
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
