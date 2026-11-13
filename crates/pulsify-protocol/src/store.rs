//! What a durable patch store provides, and the frame relay and session hub
//! built on it. `pulsify-sqlite` and `pulsify-rocksdb` implement [`PatchStore`].
use crate::{
    chunk_rows, decode, encode, own_clock, validate_vector, Body, Error, Message, PatchRow,
    VersionVector, MAX_MESSAGE_ROWS, MAX_PATCH_BYTES, MAX_SAFE_INTEGER,
};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AppendResult {
    pub inserted: usize,
    pub ready: usize,
    pub pending: usize,
    /// The committed vector of the document; `None` for an empty append.
    pub vector: Option<VersionVector>,
}

/// Immutable rows keyed by `(doc_id, sid, clock)`. Rows stay pending until
/// their actor prefix is contiguous and their dependencies are stored.
pub trait PatchStore {
    /// Carries a Pulsify protocol error code, like [`Error`].
    type Error: From<Error> + Into<Error>;
    /// Validates and stores rows of one document atomically. Exact
    /// retransmissions are ignored; a conflict stores nothing.
    fn append(&mut self, rows: &[PatchRow]) -> Result<AppendResult, Self::Error>;
    fn vector(&self, doc_id: &str) -> Result<VersionVector, Self::Error>;
    /// Ready rows the peer lacks, ordered by actor and clock.
    fn missing(&self, doc_id: &str, remote: &VersionVector) -> Result<Vec<PatchRow>, Self::Error>;
    /// `missing` and `vector` from one consistent snapshot.
    fn sync_state(
        &mut self,
        doc_id: &str,
        remote: &VersionVector,
    ) -> Result<(Vec<PatchRow>, VersionVector), Self::Error>;
}

pub fn validate_doc_id(doc_id: &str) -> Result<(), Error> {
    if doc_id.is_empty() || doc_id.contains('\0') || doc_id.encode_utf16().count() > 1024 {
        return Err(Error::new("INVALID_MESSAGE", "Invalid document ID"));
    }
    Ok(())
}

/// Checks the rows of one append, before any storage access. Returns their
/// document, or `None` when there is no row.
pub fn validate_rows(rows: &[PatchRow]) -> Result<Option<&str>, Error> {
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

/// The frames produced by one incoming frame.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct RelayOutput {
    pub doc_id: String,
    /// Frames for the requesting peer, in order.
    pub responses: Vec<Vec<u8>>,
    /// Update frames (request ID 0) for the document's other peers, when rows were inserted.
    pub broadcast: Vec<Vec<u8>>,
}

/// Serve one protocol frame from the store, like `relayStoreMessage`. Rows are
/// committed before the acknowledgement. A frame which cannot be decoded is an
/// `Err`; every other failure becomes an error frame for the peer.
pub fn relay_frame<T: PatchStore>(
    store: &mut T,
    bytes: &[u8],
    session_doc: Option<&str>,
) -> Result<RelayOutput, T::Error> {
    let Message {
        doc_id,
        request_id,
        body,
    } = decode(bytes)?;
    let mut output = RelayOutput {
        doc_id,
        ..RelayOutput::default()
    };
    if let Err(error) = serve(store, &mut output, request_id, body, session_doc) {
        let error: Error = error.into();
        output.broadcast.clear();
        output.responses = vec![encode(&Message {
            doc_id: output.doc_id.clone(),
            request_id,
            body: Body::Error {
                code: error.code.to_owned(),
                message: error.message,
            },
        })?];
    }
    Ok(output)
}

fn serve<T: PatchStore>(
    store: &mut T,
    output: &mut RelayOutput,
    request_id: u64,
    body: Body,
    session_doc: Option<&str>,
) -> Result<(), T::Error> {
    let doc_id = output.doc_id.clone();
    if session_doc.is_some_and(|pinned| pinned != doc_id) {
        return Err(Error::new("INVALID_MESSAGE", "One document per session").into());
    }
    let frame = |request_id: u64, body: Body| {
        encode(&Message {
            doc_id: doc_id.clone(),
            request_id,
            body,
        })
    };
    let rows = match body {
        Body::Connect { vv } => {
            let (rows, vv) = store.sync_state(&doc_id, &vv)?;
            let chunks = chunk_rows(rows);
            let last = chunks.len() - 1;
            for (i, rows) in chunks.into_iter().enumerate() {
                output.responses.push(frame(
                    request_id,
                    Body::Sync {
                        found: !vv.is_empty(),
                        complete: i == last,
                        vv: vv.clone(),
                        rows,
                    },
                )?);
            }
            return Ok(());
        }
        Body::SyncBack { rows, .. } | Body::Update { rows, .. } => rows,
        _ => {
            return Err(
                Error::new("INVALID_MESSAGE", "Expected connect, syncBack or update").into(),
            )
        }
    };
    let result = store.append(&rows)?;
    let inserted = result.inserted;
    let vv = match result.vector {
        Some(vector) => vector,
        None => store.vector(&doc_id)?,
    };
    output
        .responses
        .push(frame(request_id, Body::Ack { vv: vv.clone() })?);
    if inserted > 0 {
        for rows in chunk_rows(rows) {
            let vv = vv.clone();
            output.broadcast.push(frame(0, Body::Update { vv, rows })?);
        }
    }
    Ok(())
}

/// Delivers frames to one session. Returns `false` once the peer is gone.
pub trait Sink {
    fn deliver(&self, session: u64, frame: Vec<u8>) -> bool;
}
impl<F: Fn(u64, Vec<u8>) -> bool> Sink for F {
    fn deliver(&self, session: u64, frame: Vec<u8>) -> bool {
        self(session, frame)
    }
}

struct Session<S> {
    doc_id: String,
    owner: String,
    sink: S,
}

/// One writer and its sessions: each session is pinned to a document, and rows
/// stored through one session are forwarded to the document's other sessions.
pub struct Hub<T, S> {
    store: T,
    sessions: BTreeMap<u64, Session<S>>,
    next_session: u64,
}

impl<T: PatchStore, S: Sink> Hub<T, S> {
    pub fn new(store: T) -> Self {
        Self {
            store,
            sessions: BTreeMap::new(),
            next_session: 1,
        }
    }
    pub fn store(&mut self) -> &mut T {
        &mut self.store
    }
    /// `owner` groups sessions for `close_owner`, e.g. a webview label.
    pub fn open(&mut self, doc_id: &str, owner: &str, sink: S) -> Result<u64, T::Error> {
        validate_doc_id(doc_id)?;
        let session = self.next_session;
        self.next_session += 1;
        self.sessions.insert(
            session,
            Session {
                doc_id: doc_id.to_owned(),
                owner: owner.to_owned(),
                sink,
            },
        );
        Ok(session)
    }
    /// Relays one frame. Responses go to `session`, new rows to the document's other sessions.
    pub fn send(&mut self, session: u64, bytes: &[u8]) -> Result<(), T::Error> {
        let peer = self
            .sessions
            .get(&session)
            .ok_or_else(|| Error::new("CLOSED", "Unknown or closed session"))?;
        let output = relay_frame(&mut self.store, bytes, Some(&peer.doc_id))?;
        for frame in output.responses {
            if !peer.sink.deliver(session, frame) {
                self.sessions.remove(&session);
                return Err(Error::new("CLOSED", "Session receiver is gone").into());
            }
        }
        if output.broadcast.is_empty() {
            return Ok(());
        }
        let mut gone = Vec::new();
        for (id, other) in &self.sessions {
            if *id == session || other.doc_id != output.doc_id {
                continue;
            }
            for frame in &output.broadcast {
                if !other.sink.deliver(*id, frame.clone()) {
                    gone.push(*id);
                    break;
                }
            }
        }
        for id in gone {
            self.sessions.remove(&id);
        }
        Ok(())
    }
    pub fn close(&mut self, session: u64) -> bool {
        self.sessions.remove(&session).is_some()
    }
    /// Closes every session of an owner; returns how many were open.
    pub fn close_owner(&mut self, owner: &str) -> usize {
        let before = self.sessions.len();
        self.sessions.retain(|_, session| session.owner != owner);
        before - self.sessions.len()
    }
    pub fn session_count(&self) -> usize {
        self.sessions.len()
    }
}
