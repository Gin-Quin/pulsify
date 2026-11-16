//! What a durable patch store provides, and the frame relay and session hub
//! built on it. `pulsify-sqlite` and `pulsify-rocksdb` implement [`PatchStore`].
use crate::{
    chunk_rows, decode, encode, own_clock, validate_vector, Body, Error, Message, PatchRow,
    VersionVector, MAX_MESSAGE_ROWS, MAX_PATCH_BYTES, MAX_SAFE_INTEGER,
};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AppendResult {
    /// Rows stored, plus the frontiers that a known row's longer span moved:
    /// above zero, the upload is worth forwarding.
    pub inserted: usize,
    /// Rows that became ready, on arrival or once what they waited for came.
    pub ready: usize,
    pub pending: usize,
    /// The committed vector of the document; `None` for an empty append.
    pub vector: Option<VersionVector>,
}

/// Rows keyed by `(doc_id, sid, clock)`, whose operations are immutable. Rows
/// stay pending until their actor prefix is contiguous and their dependencies
/// are stored.
///
/// A store keeps the last value only of a field without history ("Fields
/// without history" in `docs/PROTOCOL.md` and `docs/STORAGE.md`): once a
/// last-value row is ready ([`last_register_of`](crate::last_register_of)), the
/// older row of its register is removed. The row before the removed one grows
/// its `span`, or a gap row ([`GAP_OPERATIONS`](crate::GAP_OPERATIONS)) stays.
pub trait PatchStore {
    /// Carries a Pulsify protocol error code, like [`Error`].
    type Error: From<Error> + Into<Error>;
    /// Validates and stores rows of one document atomically. Retransmissions
    /// are ignored, whatever their span; a conflict (other operations at a
    /// stored identity, or an actor fork) stores nothing.
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

/// Persistent lifecycle for ID-prefix subtrees. Deleted IDs can never be reused.
pub trait DocumentStore: PatchStore {
    fn is_deleted(&self, doc_id: &str) -> Result<bool, Self::Error>;
    fn delete_documents(&mut self, doc_id: &str, preserve_rows: bool)
        -> Result<usize, Self::Error>;
    fn recover_rows(&self, doc_id: &str) -> Result<Vec<PatchRow>, Self::Error>;
    fn documents(
        &self,
        doc_id: &str,
        after: &str,
        limit: usize,
    ) -> Result<Vec<String>, Self::Error>;
}

pub fn covers_document(prefix: &str, doc_id: &str) -> bool {
    doc_id == prefix
        || doc_id
            .strip_prefix(prefix)
            .is_some_and(|tail| tail.starts_with('/'))
}

pub fn document_prefixes(doc_id: &str) -> impl Iterator<Item = &str> {
    std::iter::once(doc_id).chain(
        doc_id
            .match_indices('/')
            .filter(|(i, _)| *i > 0)
            .map(|(i, _)| &doc_id[..i]),
    )
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
    /// Update frames (request ID 0) for the document's other peers, when the
    /// upload stored anything: its rows, as they were received.
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
    // Each receiver judges the rows against its own frontier.
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
    /// Notify and close sessions only after their subtree has been durably retired.
    pub fn retire_prefix(&mut self, prefix: &str) -> Result<usize, T::Error> {
        validate_doc_id(prefix)?;
        let ids: Vec<_> = self
            .sessions
            .iter()
            .filter(|(_, peer)| covers_document(prefix, &peer.doc_id))
            .map(|(id, _)| *id)
            .collect();
        for id in &ids {
            if let Some(peer) = self.sessions.remove(id) {
                let frame = encode(&Message {
                    doc_id: peer.doc_id,
                    request_id: 0,
                    body: Body::Error {
                        code: "NOT_FOUND".into(),
                        message: "Document was permanently deleted".into(),
                    },
                })?;
                peer.sink.deliver(*id, frame);
            }
        }
        Ok(ids.len())
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

impl<T: DocumentStore, S: Sink> Hub<T, S> {
    /// Atomically retire stored data, then stop affected subscribers.
    pub fn delete_documents(
        &mut self,
        prefix: &str,
        preserve_rows: bool,
    ) -> Result<usize, T::Error> {
        let count = self.store.delete_documents(prefix, preserve_rows)?;
        self.retire_prefix(prefix)?;
        Ok(count)
    }
}
