//! Pulsify protocol v1. The transport/patch journal is independent of a CRDT engine.
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_PATCH_BYTES: usize = 1024 * 1024;
pub const MAX_VECTOR_ENTRIES: usize = 1024;
pub const MAX_MESSAGE_ROWS: usize = 4096;
pub const MAX_SCHEMA_NODES: usize = 300_000;
const MAX_ROW_BATCH_NODES: usize = MAX_SCHEMA_NODES - (3 * MAX_VECTOR_ENTRIES + 16);
pub type VersionVector = Vec<(u64, u64)>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}
impl Error {
    fn new(code: &'static str, message: &str) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for Error {}
type Result<T> = std::result::Result<T, Error>;
fn invalid(message: &str) -> Error {
    Error::new("INVALID_MESSAGE", message)
}
fn limit(message: &str) -> Error {
    Error::new("LIMIT_EXCEEDED", message)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatchRow {
    pub doc_id: String,
    pub sid: u64,
    pub clock: u64,
    pub span: u64,
    pub dependencies: VersionVector,
    pub operations: Vec<u8>,
}
impl PatchRow {
    pub fn end(&self) -> u64 {
        self.clock.saturating_add(self.span)
    }
    fn validate(&self, doc_id: &str) -> Result<()> {
        validate_vector(&self.dependencies)?;
        if self.doc_id != doc_id
            || self.sid < 65536
            || self.sid > MAX_SAFE_INTEGER
            || self.clock == 0
            || self.span == 0
            || self.end() > MAX_SAFE_INTEGER
            || self.operations.is_empty()
            || own_clock(&self.dependencies, self.sid) > self.clock
        {
            return Err(invalid("Invalid patch segment"));
        }
        if self.operations.len() > MAX_PATCH_BYTES {
            return Err(limit("Patch exceeds 1 MiB"));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Body {
    Connect {
        vv: VersionVector,
    },
    Sync {
        found: bool,
        complete: bool,
        vv: VersionVector,
        rows: Vec<PatchRow>,
    },
    SyncBack {
        vv: VersionVector,
        rows: Vec<PatchRow>,
    },
    Update {
        vv: VersionVector,
        rows: Vec<PatchRow>,
    },
    Ack {
        vv: VersionVector,
    },
    Error {
        code: String,
        message: String,
    },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub doc_id: String,
    pub request_id: u64,
    pub body: Body,
}
impl Message {
    fn validate(&self) -> Result<()> {
        if self.doc_id.is_empty()
            || self.doc_id.contains('\0')
            || self.doc_id.encode_utf16().count() > 1024
            || self.request_id > MAX_SAFE_INTEGER
        {
            return Err(invalid("Invalid message header"));
        }
        match &self.body {
            Body::Connect { vv } | Body::Ack { vv } => validate_vector(vv)?,
            Body::Sync { vv, rows, .. }
            | Body::SyncBack { vv, rows }
            | Body::Update { vv, rows } => {
                validate_vector(vv)?;
                if rows.len() > MAX_MESSAGE_ROWS {
                    return Err(limit("Too many rows"));
                }
                for row in rows {
                    row.validate(&self.doc_id)?;
                }
            }
            Body::Error { .. } => {}
        }
        let nodes = match &self.body {
            Body::Connect { vv } | Body::Ack { vv } => 8 + 3 * vv.len(),
            Body::Sync { vv, rows, .. } => {
                11 + 3 * vv.len() + rows.iter().map(row_nodes).sum::<usize>()
            }
            Body::SyncBack { vv, rows } | Body::Update { vv, rows } => {
                9 + 3 * vv.len() + rows.iter().map(row_nodes).sum::<usize>()
            }
            Body::Error { .. } => 9,
        };
        if nodes > MAX_SCHEMA_NODES {
            return Err(limit("Structure limit exceeded"));
        }
        Ok(())
    }
}
fn own_clock(vv: &VersionVector, sid: u64) -> u64 {
    vv.iter()
        .find(|(id, _)| *id == sid)
        .map(|(_, clock)| *clock)
        .unwrap_or(0)
}
pub fn validate_vector(vv: &VersionVector) -> Result<()> {
    if vv.len() > MAX_VECTOR_ENTRIES {
        return Err(invalid("Too many actors"));
    }
    let mut previous = None;
    for &(sid, clock) in vv {
        if sid > MAX_SAFE_INTEGER
            || clock == 0
            || clock > MAX_SAFE_INTEGER
            || previous.is_some_and(|id| sid <= id)
        {
            return Err(invalid(
                "Vector must have unique sorted actors and positive clocks",
            ));
        }
        previous = Some(sid);
    }
    Ok(())
}
fn covers(have: &BTreeMap<u64, u64>, required: &VersionVector) -> bool {
    required
        .iter()
        .all(|(sid, clock)| have.get(sid).copied().unwrap_or(0) >= *clock)
}

struct Writer(Vec<u8>);
impl Writer {
    fn uint(&mut self, mut value: u64) {
        while value >= 128 {
            self.0.push((value as u8 & 127) | 128);
            value >>= 7;
        }
        self.0.push(value as u8);
    }
    fn bytes(&mut self, value: &[u8]) {
        self.uint(value.len() as u64);
        self.0.extend_from_slice(value);
    }
    fn text(&mut self, value: &str) {
        self.bytes(value.as_bytes());
    }
    fn vector(&mut self, vv: &VersionVector) {
        self.uint(vv.len() as u64);
        for (sid, clock) in vv {
            self.uint(*sid);
            self.uint(*clock);
        }
    }
    fn rows(&mut self, rows: &[PatchRow]) {
        self.uint(rows.len() as u64);
        for row in rows {
            self.text(&row.doc_id);
            self.uint(row.sid);
            self.uint(row.clock);
            self.uint(row.span);
            self.vector(&row.dependencies);
            self.bytes(&row.operations);
        }
    }
}
struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}
impl<'a> Reader<'a> {
    fn byte(&mut self) -> Result<u8> {
        let b = self
            .bytes
            .get(self.pos)
            .copied()
            .ok_or_else(|| invalid("Truncated frame"))?;
        self.pos += 1;
        Ok(b)
    }
    fn uint(&mut self) -> Result<u64> {
        let mut result = 0_u64;
        for i in 0..8 {
            let b = self.byte()?;
            result |= u64::from(b & 127) << (7 * i);
            if result > MAX_SAFE_INTEGER {
                return Err(invalid("Integer overflow"));
            }
            if b < 128 {
                if i > 0 && b == 0 {
                    return Err(invalid("Non-canonical varint"));
                }
                return Ok(result);
            }
        }
        Err(invalid("Integer overflow"))
    }
    fn count(&mut self, max: usize) -> Result<usize> {
        let n = self.uint()?;
        if n > max as u64 {
            return Err(limit("Collection limit exceeded"));
        }
        Ok(n as usize)
    }
    fn bytes(&mut self, max: usize) -> Result<Vec<u8>> {
        let n = self.count(max)?;
        let end = self
            .pos
            .checked_add(n)
            .ok_or_else(|| invalid("Length overflow"))?;
        let result = self
            .bytes
            .get(self.pos..end)
            .ok_or_else(|| invalid("Truncated bytes"))?
            .to_vec();
        self.pos = end;
        Ok(result)
    }
    fn text(&mut self) -> Result<String> {
        String::from_utf8(self.bytes(MAX_FRAME_BYTES)?).map_err(|_| invalid("Invalid UTF-8"))
    }
    fn boolean(&mut self) -> Result<bool> {
        match self.byte()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(invalid("Invalid boolean")),
        }
    }
    fn vector(&mut self) -> Result<VersionVector> {
        let n = self.count(MAX_VECTOR_ENTRIES)?;
        let mut result = Vec::with_capacity(n);
        for _ in 0..n {
            result.push((self.uint()?, self.uint()?));
        }
        validate_vector(&result)?;
        Ok(result)
    }
    fn rows(&mut self) -> Result<Vec<PatchRow>> {
        let n = self.count(MAX_MESSAGE_ROWS)?;
        let mut result = Vec::with_capacity(n);
        for _ in 0..n {
            result.push(PatchRow {
                doc_id: self.text()?,
                sid: self.uint()?,
                clock: self.uint()?,
                span: self.uint()?,
                dependencies: self.vector()?,
                operations: self.bytes(MAX_PATCH_BYTES)?,
            });
        }
        Ok(result)
    }
}
// Envelope v2 carries one lossless scalar run. Relays expand it without an
// application schema; their outgoing v1 rows preserve every original identity.
fn uint_size(mut n: u64) -> usize {
    let mut size = 1;
    while n >= 128 {
        size += 1;
        n >>= 7;
    }
    size
}
impl Reader<'_> {
    fn run_rows(&mut self, doc_id: &str, vv_len: usize) -> Result<Vec<PatchRow>> {
        let sid = self.uint()?;
        let clock = self.uint()?;
        let count = self.count(MAX_MESSAGE_ROWS)?;
        let lamport = self.uint()?;
        if sid < 65536
            || clock == 0
            || lamport == 0
            || count < 2
            || clock + count as u64 > MAX_SAFE_INTEGER
            || lamport + count as u64 > MAX_SAFE_INTEGER
        {
            return Err(invalid("Invalid run range"));
        }
        let schema = self.text()?;
        let target = self.text()?;
        let tag = self.uint()?;
        if tag > 1 {
            return Err(invalid("Invalid run field"));
        }
        let field_text = if tag == 0 { Some(self.text()?) } else { None };
        let field_number = if tag == 1 { self.uint()? } else { 0 };
        let layout = self.uint()?;
        let external = self.vector()?;
        if external.iter().any(|(actor, _)| *actor == sid)
            || external.len() + 1 > MAX_VECTOR_ENTRIES
        {
            return Err(invalid("Invalid run dependencies"));
        }
        if 16 + vv_len * 3 + count * (7 + 3 * (external.len() + 1)) > MAX_SCHEMA_NODES {
            return Err(limit("Expanded run node limit"));
        }
        let mut prefix = Writer(Vec::new());
        prefix.text(&schema);
        prefix.uint(1);
        prefix.uint(1);
        prefix.text(&target);
        prefix.uint(tag);
        if let Some(field) = field_text {
            prefix.text(&field);
        } else {
            prefix.uint(field_number);
        }
        prefix.uint(layout);
        let mut values = Vec::with_capacity(count);
        let mut expanded = self.bytes.len();
        for i in 0..count {
            let value = self.bytes(MAX_PATCH_BYTES)?;
            let op_bytes = 1
                + uint_size(lamport + i as u64)
                + prefix.0.len()
                + uint_size(value.len() as u64)
                + value.len()
                + 2;
            if op_bytes > MAX_PATCH_BYTES {
                return Err(limit("Expanded run payload limit"));
            }
            expanded += op_bytes
                + (external.len() + usize::from(clock + i as u64 > 1)) * 16
                + doc_id.encode_utf16().count() * 2
                + 40;
            if expanded > 64 * 1024 * 1024 {
                return Err(limit("Expanded run byte limit"));
            }
            values.push(value);
        }
        let mut rows = Vec::with_capacity(count);
        for (i, value) in values.into_iter().enumerate() {
            let mut operations = Writer(vec![2]);
            operations.uint(lamport + i as u64);
            operations.0.extend_from_slice(&prefix.0);
            operations.bytes(&value);
            operations.uint(0);
            operations.uint(0);
            let mut dependencies = external.clone();
            if clock + i as u64 > 1 {
                let at = dependencies.partition_point(|(actor, _)| *actor < sid);
                dependencies.insert(at, (sid, clock + i as u64));
            }
            rows.push(PatchRow {
                doc_id: doc_id.to_owned(),
                sid,
                clock: clock + i as u64,
                span: 1,
                dependencies,
                operations: operations.0,
            });
        }
        Ok(rows)
    }
}

pub fn encode(message: &Message) -> Result<Vec<u8>> {
    message.validate()?;
    let mut writer = Writer(vec![1, 2]);
    writer.uint(match message.body {
        Body::Connect { .. } => 1,
        Body::Sync { .. } => 2,
        Body::SyncBack { .. } => 3,
        Body::Update { .. } => 4,
        Body::Ack { .. } => 5,
        Body::Error { .. } => 6,
    });
    writer.text(&message.doc_id);
    writer.uint(message.request_id);
    match &message.body {
        Body::Connect { vv } | Body::Ack { vv } => writer.vector(vv),
        Body::Sync {
            found,
            complete,
            vv,
            rows,
        } => {
            writer.0.push(*found as u8);
            writer.0.push(*complete as u8);
            writer.vector(vv);
            writer.rows(rows);
        }
        Body::SyncBack { vv, rows } | Body::Update { vv, rows } => {
            writer.vector(vv);
            writer.rows(rows);
        }
        Body::Error { code, message } => {
            writer.text(code);
            writer.text(message);
        }
    }
    if writer.0.len() > MAX_FRAME_BYTES {
        return Err(limit("Frame exceeds 8 MiB"));
    }
    Ok(writer.0)
}
pub fn decode(bytes: &[u8]) -> Result<Message> {
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(limit("Frame exceeds 8 MiB"));
    }
    let mut reader = Reader { bytes, pos: 0 };
    let protocol = reader.uint()?;
    if !(protocol == 1 || protocol == 2) || reader.uint()? != 2 {
        return Err(Error::new(
            "UNSUPPORTED_VERSION",
            "Unsupported protocol or operation version",
        ));
    }
    let kind = reader.uint()?;
    if !(1..=6).contains(&kind) {
        return Err(invalid("Unknown message kind"));
    }
    let doc_id = reader.text()?;
    let request_id = reader.uint()?;
    if protocol == 2 && !(2..=4).contains(&kind) {
        return Err(invalid("Invalid run message kind"));
    }
    let body = match kind {
        1 => Body::Connect {
            vv: reader.vector()?,
        },
        2 => {
            let found = reader.boolean()?;
            let complete = reader.boolean()?;
            let vv = reader.vector()?;
            let rows = if protocol == 2 {
                reader.run_rows(&doc_id, vv.len())?
            } else {
                reader.rows()?
            };
            Body::Sync {
                found,
                complete,
                vv,
                rows,
            }
        }
        3 | 4 => {
            let vv = reader.vector()?;
            let rows = if protocol == 2 {
                reader.run_rows(&doc_id, vv.len())?
            } else {
                reader.rows()?
            };
            if kind == 3 {
                Body::SyncBack { vv, rows }
            } else {
                Body::Update { vv, rows }
            }
        }
        5 => Body::Ack {
            vv: reader.vector()?,
        },
        6 => Body::Error {
            code: reader.text()?,
            message: reader.text()?,
        },
        _ => unreachable!(),
    };
    if reader.pos != bytes.len() {
        return Err(invalid("Trailing bytes"));
    }
    let message = Message {
        doc_id,
        request_id,
        body,
    };
    message.validate()?;
    Ok(message)
}

/// Opaque immutable segments; the frontier advances only when dependencies exist.
#[derive(Clone, Debug)]
pub struct PatchLog {
    pub doc_id: String,
    rows: BTreeMap<(u64, u64), PatchRow>,
    pending: BTreeSet<(u64, u64)>,
    frontier: BTreeMap<u64, u64>,
    bytes: usize,
}
impl PatchLog {
    pub fn new(doc_id: &str) -> Self {
        Self {
            doc_id: doc_id.into(),
            rows: BTreeMap::new(),
            pending: BTreeSet::new(),
            frontier: BTreeMap::new(),
            bytes: 0,
        }
    }
    pub fn vector(&self) -> VersionVector {
        self.frontier
            .iter()
            .map(|(sid, clock)| (*sid, *clock))
            .collect()
    }
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }
    pub fn missing(&self, vv: &VersionVector) -> Vec<PatchRow> {
        self.rows
            .values()
            .filter(|row| row.end() > own_clock(vv, row.sid))
            .cloned()
            .collect()
    }
    pub fn append(&mut self, rows: &[PatchRow]) -> Result<()> {
        let mut next = self.clone();
        for row in rows {
            row.validate(&self.doc_id)?;
            let key = (row.sid, row.clock);
            if let Some(existing) = next.rows.get(&key) {
                if existing != row {
                    return Err(Error::new("CONFLICT", "Conflicting segment"));
                }
                continue;
            }
            for other in next.rows.values().filter(|other| other.sid == row.sid) {
                if row.clock < other.end() && other.clock < row.end() {
                    return Err(Error::new("CONFLICT", "Overlapping segments"));
                }
                let (previous, after) = if row.clock > other.clock {
                    (other, row)
                } else {
                    (row, other)
                };
                if own_clock(&after.dependencies, row.sid) < previous.end() {
                    return Err(Error::new("CONFLICT", "Actor history fork"));
                }
            }
            next.bytes += row.operations.len()
                + row.dependencies.len() * 16
                + row.doc_id.encode_utf16().count() * 2
                + 40;
            if next.rows.len() >= 100_000 || next.bytes > 64 * 1024 * 1024 {
                return Err(limit("Document history limit exceeded"));
            }
            next.rows.insert(key, row.clone());
            next.pending.insert(key);
        }
        loop {
            let ready: Vec<_> = next
                .pending
                .iter()
                .filter(|key| {
                    let row = &next.rows[key];
                    covers(&next.frontier, &row.dependencies)
                        && row.clock == next.frontier.get(&row.sid).copied().unwrap_or(1)
                })
                .copied()
                .collect();
            if ready.is_empty() {
                break;
            }
            for key in ready {
                let row = &next.rows[&key];
                next.frontier
                    .entry(row.sid)
                    .and_modify(|clock| *clock = (*clock).max(row.end()))
                    .or_insert(row.end());
                next.pending.remove(&key);
            }
        }
        if next.frontier.len() > MAX_VECTOR_ENTRIES {
            return Err(limit("Too many actors"));
        }
        *self = next;
        Ok(())
    }
}

fn row_nodes(row: &PatchRow) -> usize {
    7 + 3 * row.dependencies.len()
}

fn chunk_rows(rows: Vec<PatchRow>) -> Vec<Vec<PatchRow>> {
    let mut chunks = Vec::new();
    let mut chunk = Vec::new();
    let mut bytes = 0;
    let mut nodes = 0;
    for row in rows {
        let size = row.operations.len()
            + row.dependencies.len() * 16
            + row.doc_id.encode_utf16().count() * 4
            + 64;
        let cost = row_nodes(&row);
        if !chunk.is_empty()
            && (bytes + size > 2 * MAX_PATCH_BYTES
                || chunk.len() >= MAX_MESSAGE_ROWS
                || nodes + cost > MAX_ROW_BATCH_NODES)
        {
            chunks.push(std::mem::take(&mut chunk));
            bytes = 0;
            nodes = 0;
        }
        bytes += size;
        nodes += cost;
        chunk.push(row);
    }
    if !chunk.is_empty() || chunks.is_empty() {
        chunks.push(chunk);
    }
    chunks
}

/// Single-peer reference relay for embedding or the line-based interoperability CLI.
#[derive(Default)]
pub struct Relay {
    documents: BTreeMap<String, PatchLog>,
}
impl Relay {
    pub fn receive(&mut self, message: Message) -> Result<Vec<Message>> {
        message.validate()?;
        let Message {
            doc_id,
            request_id,
            body,
        } = message;
        let responses = match body {
            Body::Connect { vv } => {
                let log = self.documents.get(&doc_id);
                let rows = log.map(|log| log.missing(&vv)).unwrap_or_default();
                let vector = log.map(PatchLog::vector).unwrap_or_default();
                let chunks = chunk_rows(rows);
                let last = chunks.len() - 1;
                chunks
                    .into_iter()
                    .enumerate()
                    .map(|(i, rows)| Message {
                        doc_id: doc_id.clone(),
                        request_id,
                        body: Body::Sync {
                            found: log.is_some(),
                            complete: i == last,
                            vv: vector.clone(),
                            rows,
                        },
                    })
                    .collect()
            }
            Body::SyncBack { rows, .. } | Body::Update { rows, .. } => {
                let log = self
                    .documents
                    .entry(doc_id.clone())
                    .or_insert_with(|| PatchLog::new(&doc_id));
                match log.append(&rows) {
                    Ok(()) => vec![Message {
                        doc_id,
                        request_id,
                        body: Body::Ack { vv: log.vector() },
                    }],
                    Err(error) => vec![Message {
                        doc_id,
                        request_id,
                        body: Body::Error {
                            code: error.code.into(),
                            message: error.message,
                        },
                    }],
                }
            }
            _ => return Err(invalid("Expected connect or patch upload")),
        };
        Ok(responses)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dense_vectors_are_chunked_within_the_shared_structure_budget() {
        let vv: VersionVector = (0..1024).map(|i| (65536 + i, 1)).collect();
        let rows: Vec<_> = (0..127)
            .map(|i| PatchRow {
                doc_id: "dense".into(),
                sid: 200_000 + i,
                clock: 1,
                span: 1,
                dependencies: vv.clone(),
                operations: vec![1],
            })
            .collect();
        let message = Message {
            doc_id: "dense".into(),
            request_id: 1,
            body: Body::Update {
                vv: vv.clone(),
                rows: rows.clone(),
            },
        };
        assert!(encode(&message).is_err());
        let mut unchecked = Writer(vec![1, 2, 4]);
        unchecked.text("dense");
        unchecked.uint(1);
        unchecked.vector(&vv);
        unchecked.rows(&rows);
        assert!(decode(&unchecked.0).is_err());
        let chunks = chunk_rows(rows);
        assert_eq!(chunks.len(), 2);
        for rows in chunks {
            let message = Message {
                doc_id: "dense".into(),
                request_id: 1,
                body: Body::Sync {
                    found: true,
                    complete: true,
                    vv: vv.clone(),
                    rows,
                },
            };
            assert_eq!(decode(&encode(&message).unwrap()).unwrap(), message);
        }
    }
    #[test]
    fn shared_binary_fixtures() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/protocol.json")).unwrap();
        for fixture in fixtures["messages"].as_array().unwrap() {
            let bytes: Vec<u8> = fixture["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b.as_u64().unwrap() as u8)
                .collect();
            let message = decode(&bytes).unwrap();
            assert_eq!(encode(&message).unwrap(), bytes, "{}", fixture["name"]);
            for i in 0..bytes.len() {
                assert!(decode(&bytes[..i]).is_err());
            }
            let mut trailing = bytes.clone();
            trailing.push(0);
            assert!(decode(&trailing).is_err());
        }
    }
    #[test]
    fn malformed_values() {
        assert!(decode(&[1, 2, 99]).is_err());
        assert!(decode(&[2, 1]).is_err());
        assert!(decode(&[1, 2, 1, 128, 0]).is_err());
        assert!(validate_vector(&vec![(65536, 1), (65536, 2)]).is_err());
        assert!(validate_vector(&vec![(65536, MAX_SAFE_INTEGER + 1)]).is_err());
        let mut seed = 42_u32;
        for n in 0..1000 {
            let mut bytes = vec![1, 2];
            for _ in 0..n % 64 {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                bytes.push(seed as u8);
            }
            let _ = decode(&bytes);
        }
    }
    #[test]
    fn gaps_duplicates_and_conflicts() {
        let first = PatchRow {
            doc_id: "test".into(),
            sid: 65536,
            clock: 1,
            span: 2,
            dependencies: vec![],
            operations: vec![1],
        };
        let second = PatchRow {
            clock: 3,
            dependencies: vec![(65536, 3)],
            ..first.clone()
        };
        let mut log = PatchLog::new("test");
        log.append(&[second.clone()]).unwrap();
        assert_eq!(log.vector(), vec![]);
        log.append(&[first.clone()]).unwrap();
        assert_eq!(log.vector(), vec![(65536, 5)]);
        assert_eq!(log.pending_count(), 0);
        log.append(&[first.clone(), second]).unwrap();
        assert!(log
            .append(&[PatchRow {
                operations: vec![2],
                ..first.clone()
            }])
            .is_err());
        assert!(log.append(&[PatchRow { clock: 2, ..first }]).is_err());
        assert!(log.missing(&log.vector()).is_empty());
    }
    #[test]
    fn actor_frontier_does_not_skip_an_undeclared_gap() {
        let mut log = PatchLog::new("gap");
        log.append(&[PatchRow {
            doc_id: "gap".into(),
            sid: 65536,
            clock: 10,
            span: 1,
            dependencies: vec![],
            operations: vec![1],
        }])
        .unwrap();
        assert!(log.vector().is_empty());
        assert_eq!(log.pending_count(), 1);
        assert!(encode(&Message {
            doc_id: "bad\0id".into(),
            request_id: 1,
            body: Body::Connect { vv: vec![] }
        })
        .is_err());
    }
}
