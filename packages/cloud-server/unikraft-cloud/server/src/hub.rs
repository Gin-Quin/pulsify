//! One actor per root, like a Durable Object: its grants, its connected users
//! and their subscriptions. Every event of a root is processed in order.
use crate::access::{
    compare_grants, covers, role_for, root_of, valid_document_of, valid_subject, Grant, Role,
    ANY_SUBJECT, MAX_GRANTS_PER_ROOT,
};
use crate::auth::Caller;
use crate::http::CloudError;
use crate::store::{Store, StoreError};
use pulsify_protocol::{
    decode, encode, Body, Message, PatchRow, VersionVector, MAX_MESSAGE_ROWS, MAX_PATCH_BYTES,
    MAX_SCHEMA_NODES, MAX_VECTOR_ENTRIES,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc::UnboundedSender;

pub enum Outgoing {
    Binary(Vec<u8>),
    Text(String),
    Close(u16, String),
}

struct Peer {
    subject: String,
    envelope: u8,
    tx: UnboundedSender<Outgoing>,
    /// Subscribed documents and the role last sent for each.
    documents: HashMap<String, Role>,
}
impl Peer {
    fn send(&self, message: Outgoing) {
        let _ = self.tx.send(message);
    }
    fn send_role(&self, doc_id: &str, role: Option<Role>) {
        self.send(Outgoing::Text(
            json!({ "type": "role", "docId": doc_id, "role": role.map(Role::as_str) }).to_string(),
        ));
    }
    fn send_error(&self, doc_id: &str, request_id: u64, code: &str, message: &str) {
        if let Ok(frame) = encode(&Message {
            doc_id: doc_id.to_owned(),
            request_id,
            body: Body::Error {
                code: code.to_owned(),
                message: message.to_owned(),
            },
        }) {
            self.send(Outgoing::Binary(frame));
        }
    }
}

#[derive(Default)]
struct RootState {
    grants: Option<Vec<Grant>>,
    peers: HashMap<u64, Peer>,
}
impl RootState {
    fn grants(&self) -> &[Grant] {
        self.grants.as_deref().unwrap_or_default()
    }
    fn role(&self, subject: &str, doc_id: &str) -> Option<Role> {
        role_for(self.grants(), subject, doc_id)
    }
}

pub struct Root {
    pub name: String,
    state: tokio::sync::Mutex<RootState>,
}

/// All live roots. A root stays in memory while a socket or request uses it.
pub struct Hub {
    pub store: Store,
    roots: Mutex<HashMap<String, (Arc<Root>, usize)>>,
    next_connection: AtomicU64,
}

pub struct Lease {
    hub: Arc<Hub>,
    pub root: Arc<Root>,
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut roots = self.hub.roots.lock().unwrap();
        if let Some(entry) = roots.get_mut(&self.root.name) {
            entry.1 -= 1;
            if entry.1 == 0 {
                roots.remove(&self.root.name);
            }
        }
    }
}

impl Hub {
    pub fn new(store: Store) -> Arc<Self> {
        Arc::new(Self {
            store,
            roots: Mutex::default(),
            next_connection: AtomicU64::new(1),
        })
    }
    pub fn lease(self: &Arc<Self>, name: &str) -> Lease {
        let mut roots = self.roots.lock().unwrap();
        let entry = roots.entry(name.to_owned()).or_insert_with(|| {
            (
                Arc::new(Root {
                    name: name.to_owned(),
                    state: tokio::sync::Mutex::default(),
                }),
                0,
            )
        });
        entry.1 += 1;
        Lease {
            hub: self.clone(),
            root: entry.0.clone(),
        }
    }
    pub fn connection_id(&self) -> u64 {
        self.next_connection.fetch_add(1, Ordering::Relaxed)
    }
}

/// Mirror of `chunkRows`: about 2 MiB, 4096 rows and the Rust relay node budget per page.
fn chunk_rows(rows: Vec<PatchRow>) -> Vec<Vec<PatchRow>> {
    let max_nodes = MAX_SCHEMA_NODES - (3 * MAX_VECTOR_ENTRIES + 16);
    let mut chunks = Vec::new();
    let mut chunk: Vec<PatchRow> = Vec::new();
    let (mut bytes, mut nodes) = (0, 0);
    for row in rows {
        let size = row.operations.len()
            + row.dependencies.len() * 16
            + row.doc_id.encode_utf16().count() * 4
            + 64;
        let row_nodes = 7 + 3 * row.dependencies.len();
        if !chunk.is_empty()
            && (bytes + size > 2 * MAX_PATCH_BYTES
                || chunk.len() >= MAX_MESSAGE_ROWS
                || nodes + row_nodes > max_nodes)
        {
            chunks.push(std::mem::take(&mut chunk));
            bytes = 0;
            nodes = 0;
        }
        chunk.push(row);
        bytes += size;
        nodes += row_nodes;
    }
    if !chunk.is_empty() || chunks.is_empty() {
        chunks.push(chunk);
    }
    chunks
}

impl Root {
    async fn state(
        &self,
        store: &Store,
    ) -> Result<tokio::sync::MutexGuard<'_, RootState>, StoreError> {
        let mut state = self.state.lock().await;
        if state.grants.is_none() {
            state.grants = Some(store.grants(&self.name).await?);
        }
        Ok(state)
    }

    pub async fn join(
        &self,
        id: u64,
        subject: String,
        envelope: u8,
        tx: UnboundedSender<Outgoing>,
    ) {
        self.state.lock().await.peers.insert(
            id,
            Peer {
                subject,
                envelope,
                tx,
                documents: HashMap::new(),
            },
        );
    }

    pub async fn leave(&self, id: u64) {
        self.state.lock().await.peers.remove(&id);
    }

    /// Returns `false` when the connection was closed for a protocol violation.
    pub async fn receive_text(&self, id: u64, text: &str) -> bool {
        let mut state = self.state.lock().await;
        let doc_id = serde_json::from_str::<Value>(text)
            .ok()
            .and_then(|message| {
                (message.get("type")? == "unsubscribe")
                    .then(|| message.get("docId")?.as_str().map(str::to_owned))?
            });
        let Some(peer) = state.peers.get_mut(&id) else {
            return false;
        };
        match doc_id {
            Some(doc_id) => {
                peer.documents.remove(&doc_id);
                true
            }
            None => {
                peer.send(Outgoing::Close(1008, "Unknown control message".into()));
                state.peers.remove(&id);
                false
            }
        }
    }

    pub async fn receive_binary(&self, store: &Store, id: u64, bytes: &[u8]) -> bool {
        let mut state = match self.state(store).await {
            Ok(state) => state,
            Err(error) => {
                let mut state = self.state.lock().await;
                if let Some(peer) = state.peers.remove(&id) {
                    peer.send(Outgoing::Close(1011, error.message));
                }
                return false;
            }
        };
        let Some(peer) = state.peers.get(&id) else {
            return false;
        };
        let violation = if u64::from(*bytes.first().unwrap_or(&0)) > u64::from(peer.envelope) {
            Some(format!("Envelope {} was not negotiated", bytes[0]))
        } else {
            match decode(bytes) {
                Ok(message) => {
                    self.frame(&mut state, store, id, message).await;
                    None
                }
                Err(error) => Some(error.message),
            }
        };
        if let Some(reason) = violation {
            if let Some(peer) = state.peers.remove(&id) {
                peer.send(Outgoing::Close(1008, reason.chars().take(120).collect()));
            }
            return false;
        }
        true
    }

    async fn frame(&self, state: &mut RootState, store: &Store, id: u64, message: Message) {
        let Message {
            doc_id,
            request_id,
            body,
        } = message;
        let subject = state.peers[&id].subject.clone();
        if root_of(&doc_id) != self.name {
            let reason = format!("{doc_id} belongs to another root");
            return state.peers[&id].send_error(&doc_id, request_id, "FORBIDDEN", &reason);
        }
        let role = state.role(&subject, &doc_id);
        let peer = state.peers.get_mut(&id).unwrap();
        let subscribed = peer.documents.contains_key(&doc_id);
        let rows = match body {
            Body::Connect { vv } => {
                let Some(role) = role else {
                    peer.documents.remove(&doc_id);
                    peer.send_role(&doc_id, None);
                    let reason = format!("No access to {doc_id}");
                    return peer.send_error(&doc_id, request_id, "FORBIDDEN", &reason);
                };
                peer.documents.insert(doc_id.clone(), role);
                peer.send_role(&doc_id, Some(role));
                return self.sync(peer, store, &doc_id, request_id, &vv).await;
            }
            _ if !subscribed => {
                return peer.send_error(
                    &doc_id,
                    request_id,
                    "INVALID_MESSAGE",
                    "Connect to the document before uploading",
                )
            }
            _ if !role.is_some_and(Role::can_write) => {
                let (code, reason) = match role {
                    Some(_) => ("FORBIDDEN", "This session cannot write".to_owned()),
                    None => ("FORBIDDEN", format!("No access to {doc_id}")),
                };
                return peer.send_error(&doc_id, request_id, code, &reason);
            }
            Body::SyncBack { rows, .. } | Body::Update { rows, .. } => rows,
            _ => {
                return peer.send_error(
                    &doc_id,
                    request_id,
                    "INVALID_MESSAGE",
                    "Expected connect, syncBack or update",
                )
            }
        };
        let stored = async {
            let inserted = store.append(&doc_id, &rows).await?;
            Ok::<_, StoreError>((inserted, store.vector(&doc_id).await?))
        }
        .await;
        let (inserted, vector) = match stored {
            Ok(result) => result,
            Err(error) => return peer.send_error(&doc_id, request_id, error.code, &error.message),
        };
        Self::send(peer, &doc_id, request_id, Body::Ack { vv: vector.clone() });
        if inserted == 0 {
            return;
        }
        let Ok(broadcast) = encode(&Message {
            doc_id: doc_id.clone(),
            request_id: 0,
            body: Body::Update { vv: vector, rows },
        }) else {
            return;
        };
        for (other, peer) in &state.peers {
            if *other != id && peer.documents.contains_key(&doc_id) {
                peer.send(Outgoing::Binary(broadcast.clone()));
            }
        }
    }

    fn send(peer: &Peer, doc_id: &str, request_id: u64, body: Body) {
        match encode(&Message {
            doc_id: doc_id.to_owned(),
            request_id,
            body,
        }) {
            Ok(frame) => peer.send(Outgoing::Binary(frame)),
            Err(error) => peer.send_error(doc_id, request_id, error.code, &error.message),
        }
    }

    async fn sync(
        &self,
        peer: &Peer,
        store: &Store,
        doc_id: &str,
        request_id: u64,
        remote: &VersionVector,
    ) {
        let loaded = async {
            Ok::<_, StoreError>((
                store.missing(doc_id, remote).await?,
                store.vector(doc_id).await?,
            ))
        }
        .await;
        let (rows, vector) = match loaded {
            Ok(result) => result,
            Err(error) => return peer.send_error(doc_id, request_id, error.code, &error.message),
        };
        let chunks = chunk_rows(rows);
        let last = chunks.len() - 1;
        for (i, rows) in chunks.into_iter().enumerate() {
            Self::send(
                peer,
                doc_id,
                request_id,
                Body::Sync {
                    found: !vector.is_empty(),
                    complete: i == last,
                    vv: vector.clone(),
                    rows,
                },
            );
        }
    }

    /// Apply a grant change to live sessions: notify new roles, cut revoked documents.
    fn refresh_roles(state: &mut RootState, subject: &str) {
        let grants = state.grants.clone().unwrap_or_default();
        for peer in state.peers.values_mut() {
            if subject != ANY_SUBJECT && peer.subject != subject {
                continue;
            }
            let documents: Vec<(String, Role)> = peer
                .documents
                .iter()
                .map(|(d, r)| (d.clone(), *r))
                .collect();
            for (doc_id, previous) in documents {
                let role = role_for(&grants, &peer.subject, &doc_id);
                if role == Some(previous) {
                    continue;
                }
                peer.send_role(&doc_id, role);
                match role {
                    Some(role) => {
                        peer.documents.insert(doc_id, role);
                    }
                    None => {
                        peer.documents.remove(&doc_id);
                        let reason = format!("Access to {doc_id} was revoked");
                        peer.send_error(&doc_id, 0, "FORBIDDEN", &reason);
                    }
                }
            }
        }
    }

    fn assert_manager(state: &RootState, caller: &Caller, prefix: &str) -> Result<(), CloudError> {
        match caller {
            Caller::User(subject) if state.role(subject, prefix) != Some(Role::Owner) => {
                Err(CloudError::new(
                    "FORBIDDEN",
                    format!("Only an owner of {prefix} can change its grants"),
                ))
            }
            _ => Ok(()),
        }
    }

    pub async fn list_grants(
        &self,
        store: &Store,
        caller: &Caller,
        subject: Option<String>,
        prefix: Option<String>,
    ) -> Result<Value, CloudError> {
        let state = self.state(store).await.map_err(unavailable)?;
        let mut grants: Vec<&Grant> = state
            .grants()
            .iter()
            .filter(|grant| {
                (match caller {
                    Caller::Admin => true,
                    Caller::User(user) => {
                        &grant.subject == user
                            || state.role(user, &grant.prefix) == Some(Role::Owner)
                    }
                }) && subject
                    .as_ref()
                    .is_none_or(|subject| &grant.subject == subject)
                    && prefix
                        .as_ref()
                        .is_none_or(|prefix| covers(prefix, &grant.prefix))
            })
            .collect();
        grants.sort_by(|a, b| compare_grants(a, b));
        Ok(json!({ "grants": grants }))
    }

    pub async fn put_grant(
        &self,
        store: &Store,
        caller: &Caller,
        input: Value,
    ) -> Result<Value, CloudError> {
        let grant = parse_grant(&self.name, &input)?;
        let mut state = self.state(store).await.map_err(unavailable)?;
        Self::assert_manager(&state, caller, &grant.prefix)?;
        let mut grants: Vec<Grant> = state
            .grants()
            .iter()
            .filter(|other| other.subject != grant.subject || other.prefix != grant.prefix)
            .cloned()
            .collect();
        if grants.len() >= MAX_GRANTS_PER_ROOT {
            return Err(CloudError::new(
                "LIMIT_EXCEEDED",
                "Too many grants in this root",
            ));
        }
        store
            .put_grant(&self.name, &grant)
            .await
            .map_err(unavailable)?;
        grants.push(grant.clone());
        state.grants = Some(grants);
        Self::refresh_roles(&mut state, &grant.subject);
        Ok(json!({ "grant": grant }))
    }

    pub async fn delete_grant(
        &self,
        store: &Store,
        caller: &Caller,
        subject: Option<String>,
        prefix: Option<String>,
    ) -> Result<Value, CloudError> {
        let subject = subject
            .filter(|subject| valid_subject(subject))
            .ok_or_else(|| CloudError::new("BAD_REQUEST", "Invalid subject"))?;
        let prefix = prefix
            .filter(|prefix| valid_document_of(&self.name, prefix))
            .ok_or_else(|| document_error(&self.name))?;
        let mut state = self.state(store).await.map_err(unavailable)?;
        Self::assert_manager(&state, caller, &prefix)?;
        let removed = store
            .delete_grant(&self.name, &subject, &prefix)
            .await
            .map_err(unavailable)?;
        if removed {
            let grants = state
                .grants()
                .iter()
                .filter(|grant| grant.subject != subject || grant.prefix != prefix)
                .cloned()
                .collect();
            state.grants = Some(grants);
            Self::refresh_roles(&mut state, &subject);
        }
        Ok(json!({ "removed": removed }))
    }

    pub async fn usage(&self, store: &Store, caller: &Caller) -> Result<Value, CloudError> {
        if *caller != Caller::Admin {
            return Err(CloudError::new("FORBIDDEN", "Usage requires the API key"));
        }
        let state = self.state(store).await.map_err(unavailable)?;
        let usage = store.usage(&self.name).await.map_err(unavailable)?;
        Ok(json!({
            "root": self.name,
            "documents": usage.documents,
            "rows": usage.rows,
            "bytes": usage.bytes,
            "connections": state.peers.len(),
        }))
    }
}

fn unavailable(error: StoreError) -> CloudError {
    CloudError::new("UNAVAILABLE", error.message)
}

fn document_error(root: &str) -> CloudError {
    CloudError::new(
        "BAD_REQUEST",
        format!("Expected a document ID inside the root \"{root}\""),
    )
}

fn parse_grant(root: &str, input: &Value) -> Result<Grant, CloudError> {
    let object = input
        .as_object()
        .ok_or_else(|| CloudError::new("BAD_REQUEST", "Expected a grant object"))?;
    let subject = object
        .get("subject")
        .and_then(Value::as_str)
        .filter(|subject| valid_subject(subject))
        .ok_or_else(|| CloudError::new("BAD_REQUEST", "Invalid subject"))?;
    let prefix = object
        .get("prefix")
        .and_then(Value::as_str)
        .filter(|prefix| valid_document_of(root, prefix))
        .ok_or_else(|| document_error(root))?;
    let role = object
        .get("role")
        .and_then(Value::as_str)
        .and_then(Role::parse)
        .ok_or_else(|| {
            CloudError::new("BAD_REQUEST", "Role must be one of reader, editor, owner")
        })?;
    Ok(Grant {
        subject: subject.to_owned(),
        prefix: prefix.to_owned(),
        role,
    })
}
