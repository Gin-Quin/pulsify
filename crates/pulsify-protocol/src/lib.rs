//! Pulsify protocol v1. The transport/patch journal is independent of a CRDT engine.
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

mod store;
pub use store::{
    covers_document, document_prefixes, relay_frame, validate_doc_id, validate_rows, AppendResult,
    DocumentStore, Hub, PatchStore, RelayOutput, Sink,
};

/// The version of operation payloads, their first byte.
pub const OPERATIONS_VERSION: u8 = 3;
/// The payload of a gap row: no operation. Its sequence numbers held writes
/// that were replaced, and it stands where no earlier row can cover them.
pub const GAP_OPERATIONS: [u8; 4] = [OPERATIONS_VERSION, 1, 0, 0];
pub fn is_gap(operations: &[u8]) -> bool {
    operations == GAP_OPERATIONS
}

/// What a journal or a store reads from the head of a last-value row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LastRegister<'a> {
    pub lamport: u64,
    /// The register, compared as bytes: the encoded target and field of the write.
    pub register: &'a [u8],
}

/// A varuint of a payload head, read as leniently as the TypeScript codec does.
fn head_uint(bytes: &[u8], pos: &mut usize) -> Option<u64> {
    let mut value = 0_u64;
    for shift in (0..=56).step_by(7) {
        let byte = *bytes.get(*pos)?;
        *pos += 1;
        value |= u64::from(byte & 127) << shift;
        if value > MAX_SAFE_INTEGER {
            return None;
        }
        if byte < 128 {
            return Some(value);
        }
    }
    None
}

/// `None` unless the payload is one last-value write: exactly one operation of
/// kind 7 (assign) or 8 (delete), to a register that keeps no history. Mirror
/// of `lastRegisterOf`: nothing is decoded beyond the head,
/// `version, lamport, schema, count = 1, kind, target, field`.
pub fn last_register_of(operations: &[u8]) -> Option<LastRegister<'_>> {
    let mut pos = 0;
    // The next read fails when a length reaches beyond the payload.
    let skip = |pos: &mut usize| -> Option<()> {
        let length = usize::try_from(head_uint(operations, pos)?).ok()?;
        *pos = pos.checked_add(length)?;
        Some(())
    };
    if head_uint(operations, &mut pos)? != u64::from(OPERATIONS_VERSION) {
        return None;
    }
    let lamport = head_uint(operations, &mut pos)?;
    skip(&mut pos)?;
    if head_uint(operations, &mut pos)? != 1 {
        return None;
    }
    if !matches!(head_uint(operations, &mut pos)?, 7 | 8) {
        return None;
    }
    let start = pos;
    skip(&mut pos)?;
    if head_uint(operations, &mut pos)? == 0 {
        skip(&mut pos)?;
    } else {
        head_uint(operations, &mut pos)?;
    }
    Some(LastRegister {
        lamport,
        register: operations.get(start..pos)?,
    })
}

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
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
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
            let mut operations = Writer(vec![3]);
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
    let mut writer = Writer(vec![1, 3]);
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
    let operations = reader.uint()?;
    if !((protocol == 1 || protocol == 2) && operations == 3) {
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

/// The row that holds a register without history: the newest write to it.
#[derive(Clone, Copy, Debug)]
struct Holder {
    sid: u64,
    clock: u64,
    lamport: u64,
}

/// Journal bytes charged for a row.
fn cost(row: &PatchRow) -> usize {
    row.operations.len() + row.dependencies.len() * 16 + row.doc_id.encode_utf16().count() * 2 + 40
}
/// A row without operations, covering sequence numbers of replaced writes.
fn gap_row(doc_id: &str, sid: u64, clock: u64, span: u64) -> PatchRow {
    PatchRow {
        doc_id: doc_id.to_owned(),
        sid,
        clock,
        span,
        dependencies: if clock > 1 {
            vec![(sid, clock)]
        } else {
            vec![]
        },
        operations: GAP_OPERATIONS.to_vec(),
    }
}
fn differ(held: &[u8], incoming: &[u8]) -> bool {
    !is_gap(held) && !is_gap(incoming) && held != incoming
}

/// An undo entry recorded while mutating a `PatchLog` during `append`.
enum RowUndo {
    Inserted((u64, u64)),
    Removed {
        key: (u64, u64),
        row: Box<PatchRow>,
        was_pending: bool,
    },
}

/// Opaque segments whose operations are immutable; the frontier advances only
/// when dependencies exist. A register without history keeps one row, the
/// newest write: see "Fields without history" in `docs/PROTOCOL.md`.
#[derive(Clone, Debug)]
pub struct PatchLog {
    pub doc_id: String,
    rows: BTreeMap<(u64, u64), PatchRow>,
    pending: BTreeSet<(u64, u64)>,
    frontier: BTreeMap<u64, u64>,
    /// The row that holds each register without history.
    registers: BTreeMap<Vec<u8>, Holder>,
    bytes: usize,
}
impl PatchLog {
    pub fn new(doc_id: &str) -> Self {
        Self {
            doc_id: doc_id.into(),
            rows: BTreeMap::new(),
            pending: BTreeSet::new(),
            frontier: BTreeMap::new(),
            registers: BTreeMap::new(),
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
    /// How many rows the journal holds, waiting ones included.
    pub fn len(&self) -> usize {
        self.rows.len()
    }
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }
    pub fn missing(&self, vv: &VersionVector) -> Vec<PatchRow> {
        let mut result = Vec::new();
        for (&sid, &frontier) in &self.frontier {
            let remote = own_clock(vv, sid);
            if remote >= frontier {
                continue;
            }
            if let Some((_, row)) = self.rows.range((sid, 0)..=(sid, remote)).next_back() {
                if row.end() > remote {
                    result.push(row.clone());
                }
            }
            for (_, row) in self
                .rows
                .range((sid, remote.saturating_add(1))..(sid, frontier))
            {
                result.push(row.clone());
            }
        }
        result
    }
    /// Stores rows atomically: a conflict leaves the journal as it was.
    pub fn append(&mut self, rows: &[PatchRow]) -> Result<()> {
        let mut row_undo = Vec::new();
        let mut frontier_undo = Vec::new();
        let mut fresh = Vec::new();
        let old_bytes = self.bytes;
        let result = self.insert(rows, &mut row_undo, &mut frontier_undo, &mut fresh);
        if result.is_err() {
            for (sid, prev) in frontier_undo.into_iter().rev() {
                match prev {
                    Some(clock) => {
                        self.frontier.insert(sid, clock);
                    }
                    None => {
                        self.frontier.remove(&sid);
                    }
                }
            }
            for key in fresh {
                self.pending.insert(key);
            }
            for op in row_undo.into_iter().rev() {
                match op {
                    RowUndo::Inserted(key) => {
                        self.rows.remove(&key);
                        self.pending.remove(&key);
                    }
                    RowUndo::Removed {
                        key,
                        row,
                        was_pending,
                    } => {
                        self.rows.insert(key, *row);
                        if was_pending {
                            self.pending.insert(key);
                        }
                    }
                }
            }
            self.bytes = old_bytes;
            return result;
        }
        for key in fresh {
            self.settle(key);
        }
        Ok(())
    }

    fn drop_row(&mut self, key: (u64, u64)) {
        if let Some(row) = self.rows.remove(&key) {
            self.bytes -= cost(&row);
        }
        self.pending.remove(&key);
    }

    fn drop_row_undo(&mut self, key: (u64, u64), undo: &mut Vec<RowUndo>) {
        if let Some(row) = self.rows.remove(&key) {
            self.bytes -= cost(&row);
            let was_pending = self.pending.remove(&key);
            undo.push(RowUndo::Removed {
                key,
                row: Box::new(row),
                was_pending,
            });
        }
    }

    fn insert(
        &mut self,
        rows: &[PatchRow],
        row_undo: &mut Vec<RowUndo>,
        frontier_undo: &mut Vec<(u64, Option<u64>)>,
        fresh: &mut Vec<(u64, u64)>,
    ) -> Result<()> {
        // A row that starts below its actor's frontier is already known, or was
        // replaced here: only the sequence numbers its span covers beyond the
        // frontier are news, and they come as a gap row to append.
        let mut incoming: Vec<PatchRow> = Vec::with_capacity(rows.len());
        let mut gaps: BTreeMap<u64, usize> = BTreeMap::new();
        for row in rows {
            row.validate(&self.doc_id)?;
            let frontier = self.frontier.get(&row.sid).copied().unwrap_or(1);
            if row.clock >= frontier {
                incoming.push(row.clone());
                continue;
            }
            if let Some(held) = self.rows.get(&(row.sid, row.clock)) {
                if differ(&held.operations, &row.operations) {
                    return Err(Error::new("CONFLICT", "Conflicting segment"));
                }
            }
            if row.end() <= frontier {
                continue;
            }
            let span = row.end() - frontier;
            match gaps.get(&row.sid) {
                Some(&at) => incoming[at].span = incoming[at].span.max(span),
                None => {
                    gaps.insert(row.sid, incoming.len());
                    incoming.push(gap_row(&self.doc_id, row.sid, frontier, span));
                }
            }
        }
        for row in incoming {
            let key = (row.sid, row.clock);
            if let Some(existing) = self.rows.get(&key) {
                // A span is how much a peer has replaced since: only contents conflict.
                if differ(&existing.operations, &row.operations) {
                    return Err(Error::new("CONFLICT", "Conflicting segment"));
                }
                // The longer span knows of more replaced writes: it takes the place.
                if row.end() <= existing.end() {
                    continue;
                }
                self.drop_row_undo(key, row_undo);
            }
            if let Some(before) = self.rows.range((row.sid, 0)..key).next_back().map(|e| e.1) {
                // It starts among the writes that a waiting row has replaced.
                if before.end() > row.clock {
                    continue;
                }
                if own_clock(&row.dependencies, row.sid) < before.end() {
                    return Err(Error::new("CONFLICT", "Actor history fork"));
                }
            }
            // Rows still waiting whose sequence numbers this row declares replaced.
            while let Some(after) = self
                .rows
                .range(key..=(row.sid, u64::MAX))
                .next()
                .map(|e| e.1)
            {
                if after.clock >= row.end() {
                    if own_clock(&after.dependencies, row.sid) < row.end() {
                        return Err(Error::new("CONFLICT", "Actor history fork"));
                    }
                    break;
                }
                let after_key = (after.sid, after.clock);
                self.drop_row_undo(after_key, row_undo);
            }
            self.bytes += cost(&row);
            if self.rows.len() >= 100_000 || self.bytes > 64 * 1024 * 1024 {
                return Err(limit("Document history limit exceeded"));
            }
            self.rows.insert(key, row);
            self.pending.insert(key);
            row_undo.push(RowUndo::Inserted(key));
        }
        loop {
            let mut ready = Vec::new();
            for &key in &self.pending {
                let row = &self.rows[&key];
                if row.clock == self.frontier.get(&row.sid).copied().unwrap_or(1)
                    && covers(&self.frontier, &row.dependencies)
                {
                    let prev = self.frontier.insert(row.sid, row.end());
                    frontier_undo.push((row.sid, prev));
                    ready.push(key);
                }
            }
            if ready.is_empty() {
                break;
            }
            for key in ready {
                self.pending.remove(&key);
                fresh.push(key);
            }
            if self.pending.is_empty() {
                break;
            }
        }
        if self.frontier.len() > MAX_VECTOR_ENTRIES {
            return Err(limit("Too many actors"));
        }
        Ok(())
    }

    /// Once a row is applicable: a register without history holds one row, the
    /// newest write, and a gap folds into the row before it.
    fn settle(&mut self, key: (u64, u64)) {
        let Some(row) = self.rows.get(&key) else {
            return;
        };
        if is_gap(&row.operations) {
            return self.kill(key);
        }
        let Some(last) = last_register_of(&row.operations) else {
            return;
        };
        let (lamport, register) = (last.lamport, last.register.to_vec());
        let held = self.registers.get(&register).copied();
        if let Some(held) = held {
            if (held.sid, held.clock) == key {
                return;
            }
            // Last writer wins, by Lamport time then actor: the same order as the
            // register itself, so the row that stays is the value every replica shows.
            if (held.lamport, held.sid) > (lamport, key.0) {
                return self.kill(key);
            }
        }
        let holder = Holder {
            sid: key.0,
            clock: key.1,
            lamport,
        };
        self.registers.insert(register, holder);
        if let Some(held) = held {
            self.kill((held.sid, held.clock));
        }
    }

    /// Remove a row; the row before it covers its sequence numbers, or a gap does.
    fn kill(&mut self, key: (u64, u64)) {
        let Some(row) = self.rows.get(&key) else {
            return;
        };
        if self.pending.contains(&key) {
            return;
        }
        let span = row.span;
        let previous = self
            .rows
            .range((key.0, 0)..key)
            .next_back()
            .filter(|(at, previous)| previous.end() == key.1 && !self.pending.contains(at))
            .map(|(at, _)| *at);
        match previous {
            Some(previous) => {
                self.drop_row(key);
                if let Some(previous) = self.rows.get_mut(&previous) {
                    previous.span += span;
                }
            }
            None if is_gap(&row.operations) => {}
            None => {
                let gap = gap_row(&self.doc_id, key.0, key.1, span);
                self.bytes = self.bytes + cost(&gap) - cost(row);
                self.rows.insert(key, gap);
            }
        }
    }
}

fn row_nodes(row: &PatchRow) -> usize {
    7 + 3 * row.dependencies.len()
}

/// Mirror of `chunkRows`: about 2 MiB, 4096 rows and the relay node budget per page.
pub fn chunk_rows(rows: Vec<PatchRow>) -> Vec<Vec<PatchRow>> {
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
                let found = !vector.is_empty();
                let chunks = chunk_rows(rows);
                let last = chunks.len() - 1;
                chunks
                    .into_iter()
                    .enumerate()
                    .map(|(i, rows)| Message {
                        doc_id: doc_id.clone(),
                        request_id,
                        body: Body::Sync {
                            found,
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
        let mut unchecked = Writer(vec![1, 3, 4]);
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
        assert!(decode(&[1, 3, 99]).is_err());
        assert!(decode(&[2, 1]).is_err());
        // State-only envelopes are never accepted as durable exact history.
        assert!(decode(&[3, 3, 4]).is_err());
        assert!(decode(&[1, 3, 1, 128, 0]).is_err());
        assert!(validate_vector(&vec![(65536, 1), (65536, 2)]).is_err());
        assert!(validate_vector(&vec![(65536, MAX_SAFE_INTEGER + 1)]).is_err());
        let mut seed = 42_u32;
        for n in 0..1000 {
            let mut bytes = vec![1, 3];
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
        // A row that starts among the writes another row covers is ignored.
        log.append(&[PatchRow { clock: 2, ..first }]).unwrap();
        assert_eq!(log.len(), 2);
        assert!(log.missing(&log.vector()).is_empty());
        // A fork: the next row does not build on the actor's history.
        let fork = PatchRow {
            doc_id: "test".into(),
            sid: 65536,
            clock: 5,
            span: 1,
            dependencies: vec![(65536, 4)],
            operations: vec![1],
        };
        assert_eq!(
            log.append(&[fork]).unwrap_err().message,
            "Actor history fork"
        );
    }

    const A: u64 = 65536;
    const B: u64 = 65537;
    fn unhex(value: &str) -> Vec<u8> {
        (0..value.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&value[i..i + 2], 16).unwrap())
            .collect()
    }
    fn own(sid: u64, clock: u64) -> VersionVector {
        if clock > 1 {
            vec![(sid, clock)]
        } else {
            vec![]
        }
    }
    /// A row that is not a last-value write.
    fn kept(sid: u64, clock: u64) -> PatchRow {
        PatchRow {
            doc_id: "doc".into(),
            sid,
            clock,
            span: 1,
            dependencies: own(sid, clock),
            operations: vec![OPERATIONS_VERSION, clock as u8, 0, 1, 3, sid as u8],
        }
    }
    /// One kind 7 write to the numeric field `field` of the node "n".
    fn write(sid: u64, clock: u64, lamport: u8, field: u8) -> PatchRow {
        PatchRow {
            operations: vec![
                OPERATIONS_VERSION,
                lamport,
                0,
                1,
                7,
                1,
                b'n',
                1,
                field,
                sid as u8,
            ],
            ..kept(sid, clock)
        }
    }
    fn spans(log: &PatchLog) -> Vec<(u64, u64, u64)> {
        log.missing(&vec![])
            .iter()
            .map(|row| (row.sid, row.clock, row.span))
            .collect()
    }
    fn held_spans(log: &PatchLog) -> Vec<(u64, u64, u64)> {
        log.rows
            .values()
            .map(|row| (row.sid, row.clock, row.span))
            .collect()
    }

    #[test]
    fn reads_the_register_of_a_last_value_row() {
        // Rows written by the TypeScript engine: a deletion, then assignments
        // to a string field and to a numeric one.
        for (operations, lamport, register) in [
            (
                "030520356337343230653061663033343238346437303438313861633038323965383801080936353533363a313a320101",
                5,
                "0936353533363a313a320101",
            ),
            (
                "030620356337343230653061663033343238346437303438313861633038323965383801070936353533363a313a330001780a0201790000",
                6,
                "0936353533363a313a33000178",
            ),
            (
                "030720356337343230653061663033343238346437303438313861633038323965383801070936353533363a313a300100030201630000",
                7,
                "0936353533363a313a300100",
            ),
        ] {
            let operations = unhex(operations);
            let last = last_register_of(&operations).unwrap();
            assert_eq!((last.lamport, last.register), (lamport, &unhex(register)[..]));
            assert!(!is_gap(&operations));
            // Cut anywhere inside its head, it is not a last-value row.
            let head = operations.len() - last.register.len();
            for cut in 0..head {
                assert_eq!(last_register_of(&operations[..cut]), None);
            }
        }
        assert!(is_gap(&GAP_OPERATIONS) && is_gap(&[3, 1, 0, 0]));
        assert_eq!(last_register_of(&GAP_OPERATIONS), None);
        let one = write(A, 1, 9, 2).operations;
        assert_eq!(last_register_of(&one).unwrap().register, [1, b'n', 1, 2]);
        // Other kinds, two operations, another version or a length beyond the end.
        for (at, byte) in [(4, 1), (4, 2), (4, 9), (3, 2), (0, 2), (5, 200)] {
            let mut other = one.clone();
            other[at] = byte;
            assert_eq!(last_register_of(&other), None, "{other:?}");
        }
        assert!(!is_gap(&[3, 1, 0, 0, 0]) && !is_gap(&[3, 2, 0, 0]) && !is_gap(&[]));
    }

    #[test]
    fn a_register_rewritten_many_times_keeps_one_row() {
        let mut log = PatchLog::new("doc");
        log.append(&[kept(A, 1), kept(B, 1)]).unwrap();
        for clock in 2..=300u64 {
            // Two registers of A, and one that B also writes with older times.
            let field = (clock % 2) as u8;
            log.append(&[write(A, clock, 100, field)]).unwrap();
            log.append(&[write(B, clock, 1, 0)]).unwrap();
        }
        // A: its first row and the last write to each register. B's writes all
        // arrived already replaced: its first row covers them.
        assert_eq!(
            spans(&log),
            vec![(A, 1, 298), (A, 299, 1), (A, 300, 1), (B, 1, 300)]
        );
        assert_eq!(log.vector(), vec![(A, 301), (B, 301)]);
        assert_eq!(log.registers.len(), 2);
        // The rows that stay are the newest writes.
        assert_eq!(
            log.missing(&vec![(A, 300), (B, 301)]),
            vec![write(A, 300, 100, 0)]
        );
    }

    #[test]
    fn a_replaced_first_row_stays_as_a_gap() {
        let mut log = PatchLog::new("doc");
        log.append(&[write(A, 1, 1, 0)]).unwrap();
        log.append(&[write(B, 1, 2, 0)]).unwrap();
        let gap = gap_row("doc", A, 1, 1);
        assert_eq!(log.missing(&vec![]), vec![gap.clone(), write(B, 1, 2, 0)]);
        // The gap takes the replaced writes that follow, and folds into nothing.
        log.append(&[write(A, 2, 1, 0)]).unwrap();
        assert_eq!(spans(&log), vec![(A, 1, 2), (B, 1, 1)]);
        // A peer that kept less sends the same sequence numbers as a gap row.
        log.append(&[gap, write(A, 1, 1, 0)]).unwrap();
        log.append(&[gap_row("doc", B, 2, 3)]).unwrap();
        assert_eq!(spans(&log), vec![(A, 1, 2), (B, 1, 4)]);
        assert_eq!(log.vector(), vec![(A, 3), (B, 5)]);
    }

    #[test]
    fn a_known_row_with_a_longer_span_moves_the_frontier() {
        let mut log = PatchLog::new("doc");
        log.append(&[kept(A, 1), kept(A, 2), kept(A, 7)]).unwrap();
        assert_eq!(log.pending_count(), 1);
        // The sender replaced two writes after the second one.
        let long = PatchRow {
            span: 3,
            ..kept(A, 2)
        };
        log.append(std::slice::from_ref(&long)).unwrap();
        assert_eq!(log.vector(), vec![(A, 5)]);
        assert_eq!(spans(&log), vec![(A, 1, 1), (A, 2, 3)]);
        assert_eq!(held_spans(&log), vec![(A, 1, 1), (A, 2, 3), (A, 7, 1)]);
        // Sent again, or shorter, it changes nothing; other contents conflict.
        log.append(&[long, kept(A, 2), kept(A, 1)]).unwrap();
        assert_eq!(log.vector(), vec![(A, 5)]);
        let changed = PatchRow {
            operations: vec![9],
            ..kept(A, 2)
        };
        assert_eq!(log.append(&[changed]).unwrap_err().code, "CONFLICT");
        // Up to a waiting row, which becomes applicable.
        log.append(&[PatchRow {
            span: 5,
            ..kept(A, 2)
        }])
        .unwrap();
        assert_eq!(log.vector(), vec![(A, 8)]);
        assert_eq!(spans(&log), vec![(A, 1, 1), (A, 2, 5), (A, 7, 1)]);
        assert_eq!(log.pending_count(), 0);
    }

    #[test]
    fn a_row_replaces_the_waiting_rows_its_span_covers() {
        let mut log = PatchLog::new("doc");
        log.append(&[kept(A, 1), kept(A, 4), kept(A, 5), kept(A, 7)])
            .unwrap();
        assert_eq!(log.pending_count(), 3);
        // A waiting row that starts inside another one's span is dropped.
        let wide = PatchRow {
            span: 2,
            ..kept(A, 4)
        };
        log.append(&[wide.clone(), kept(A, 5)]).unwrap();
        assert_eq!(spans(&log), vec![(A, 1, 1)]);
        assert_eq!(held_spans(&log), vec![(A, 1, 1), (A, 4, 2), (A, 7, 1)]);
        // The row at the frontier covers every waiting row up to the last.
        let long = PatchRow {
            span: 5,
            ..kept(A, 2)
        };
        log.append(&[long]).unwrap();
        assert_eq!(spans(&log), vec![(A, 1, 1), (A, 2, 5), (A, 7, 1)]);
        assert_eq!((log.vector(), log.pending_count()), (vec![(A, 8)], 0));
        // What it replaced is ignored from now on, whatever it holds.
        log.append(&[wide, kept(A, 5)]).unwrap();
        assert_eq!(log.len(), 3);
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

    #[test]
    fn append_is_atomic_on_error_and_scales_subquadratically() {
        // Verify rollback restores rows, pending, frontier and bytes identically.
        let mut log = PatchLog::new("doc");
        log.append(&[kept(A, 1), kept(A, 4), kept(A, 5)]).unwrap();
        let snapshot = (
            log.rows.clone(),
            log.pending.clone(),
            log.frontier.clone(),
            log.bytes,
        );
        // Batch drops pending (A, 4) and (A, 5), then fails on a fork at (A, 6).
        let wide = PatchRow {
            span: 2,
            ..kept(A, 4)
        };
        let fork = PatchRow {
            dependencies: vec![(A, 4)],
            ..kept(A, 6)
        };
        assert_eq!(log.append(&[wide, fork]).unwrap_err().code, "CONFLICT");
        assert_eq!(
            (
                log.rows.clone(),
                log.pending.clone(),
                log.frontier.clone(),
                log.bytes
            ),
            snapshot
        );
        // Verify rollback on MAX_VECTOR_ENTRIES after advancing the frontier.
        let mut full = PatchLog::new("doc");
        let actors: Vec<_> = (0..MAX_VECTOR_ENTRIES as u64)
            .map(|i| kept(A + i, 1))
            .collect();
        full.append(&actors).unwrap();
        let full_snapshot = (
            full.rows.clone(),
            full.pending.clone(),
            full.frontier.clone(),
            full.bytes,
        );
        assert_eq!(
            full.append(&[kept(A, 2), kept(A + MAX_VECTOR_ENTRIES as u64, 1)])
                .unwrap_err()
                .code,
            "LIMIT_EXCEEDED"
        );
        assert_eq!(
            (full.rows, full.pending, full.frontier, full.bytes),
            full_snapshot
        );

        // Scaling regression check (J1): filling 4n rows one-by-one vs n rows.
        // Quadratic cloning takes ~16x; subquadratic append takes ~4-5x.
        let measure = |count: u64| {
            let rows: Vec<_> = (1..=count).map(|c| kept(A, c)).collect();
            let start = std::time::Instant::now();
            let mut l = PatchLog::new("doc");
            for r in &rows {
                l.append(std::slice::from_ref(r)).unwrap();
            }
            assert_eq!(l.len(), count as usize);
            start.elapsed()
        };
        // Warm up once, then compare n vs 4n.
        let _ = measure(500);
        let small = measure(2000).as_secs_f64().max(1e-6);
        let large = measure(8000).as_secs_f64();
        assert!(
            large / small < 10.0,
            "PatchLog::append scaling regressed: 2000={small:.4}s, 8000={large:.4}s (ratio {:.2})",
            large / small
        );
    }

    #[test]
    fn missing_and_relay_omit_pending_rows_until_ready() {
        let mut log = PatchLog::new("doc");
        log.append(&[kept(A, 2)]).unwrap();
        assert_eq!(log.vector(), vec![]);
        assert_eq!(log.pending_count(), 1);
        assert!(log.missing(&vec![]).is_empty());

        // Relay reports found=false and no rows when only pending rows exist.
        let mut relay = Relay::default();
        relay
            .receive(Message {
                doc_id: "doc".into(),
                request_id: 1,
                body: Body::Update {
                    vv: vec![],
                    rows: vec![kept(A, 2)],
                },
            })
            .unwrap();
        let sync = relay
            .receive(Message {
                doc_id: "doc".into(),
                request_id: 2,
                body: Body::Connect { vv: vec![] },
            })
            .unwrap();
        assert_eq!(
            sync,
            vec![Message {
                doc_id: "doc".into(),
                request_id: 2,
                body: Body::Sync {
                    found: false,
                    complete: true,
                    vv: vec![],
                    rows: vec![],
                },
            }]
        );

        // Once the missing dependency arrives, both rows become ready and served.
        log.append(&[kept(A, 1)]).unwrap();
        assert_eq!(log.pending_count(), 0);
        assert_eq!(log.missing(&vec![]), vec![kept(A, 1), kept(A, 2)]);
        relay
            .receive(Message {
                doc_id: "doc".into(),
                request_id: 3,
                body: Body::Update {
                    vv: vec![],
                    rows: vec![kept(A, 1)],
                },
            })
            .unwrap();
        let sync = relay
            .receive(Message {
                doc_id: "doc".into(),
                request_id: 4,
                body: Body::Connect { vv: vec![] },
            })
            .unwrap();
        assert_eq!(
            sync,
            vec![Message {
                doc_id: "doc".into(),
                request_id: 4,
                body: Body::Sync {
                    found: true,
                    complete: true,
                    vv: vec![(A, 3)],
                    rows: vec![kept(A, 1), kept(A, 2)],
                },
            }]
        );
    }
}
