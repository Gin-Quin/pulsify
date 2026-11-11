use crate::{relay_frame, validate_doc_id, Error, Result, SqliteStore};
use std::collections::BTreeMap;

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
pub struct Hub<S> {
    store: SqliteStore,
    sessions: BTreeMap<u64, Session<S>>,
    next_session: u64,
}

impl<S: Sink> Hub<S> {
    pub fn new(store: SqliteStore) -> Self {
        Self {
            store,
            sessions: BTreeMap::new(),
            next_session: 1,
        }
    }
    pub fn store(&mut self) -> &mut SqliteStore {
        &mut self.store
    }
    /// `owner` groups sessions for `close_owner`, e.g. a webview label.
    pub fn open(&mut self, doc_id: &str, owner: &str, sink: S) -> Result<u64> {
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
    pub fn send(&mut self, session: u64, bytes: &[u8]) -> Result<()> {
        let peer = self
            .sessions
            .get(&session)
            .ok_or_else(|| Error::new("CLOSED", "Unknown or closed session"))?;
        let output = relay_frame(&mut self.store, bytes, Some(&peer.doc_id))?;
        for frame in output.responses {
            if !peer.sink.deliver(session, frame) {
                self.sessions.remove(&session);
                return Err(Error::new("CLOSED", "Session receiver is gone"));
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::tests::{connect, upload};
    use crate::store::tests::{next, A};
    use pulsify_protocol::{decode, Body};
    use std::cell::RefCell;
    use std::rc::Rc;

    type Inbox = Rc<RefCell<Vec<(u64, Body)>>>;
    type TestSink = Box<dyn Fn(u64, Vec<u8>) -> bool>;
    fn sink(inbox: &Inbox, alive: bool) -> TestSink {
        let inbox = inbox.clone();
        Box::new(move |session, frame| {
            inbox
                .borrow_mut()
                .push((session, decode(&frame).unwrap().body));
            alive
        })
    }
    fn hub() -> Hub<TestSink> {
        Hub::new(SqliteStore::open_in_memory().unwrap())
    }

    #[test]
    fn broadcasts_new_rows_to_other_sessions_of_the_document() {
        let mut hub = hub();
        let inbox: Inbox = Rc::default();
        let first = hub.open("doc", "main", sink(&inbox, true)).unwrap();
        let second = hub.open("doc", "other", sink(&inbox, true)).unwrap();
        let unrelated = hub.open("elsewhere", "main", sink(&inbox, true)).unwrap();
        hub.send(first, &connect(1, vec![])).unwrap();
        assert_eq!(inbox.borrow().len(), 1);
        inbox.borrow_mut().clear();
        hub.send(first, &upload(2, vec![next(A, 1, 1)])).unwrap();
        let received = inbox.take();
        assert_eq!(received.len(), 2);
        assert_eq!(received[0], (first, Body::Ack { vv: vec![(A, 2)] }));
        assert_eq!(received[1].0, second);
        assert!(matches!(received[1].1, Body::Update { .. }));
        hub.send(second, &upload(3, vec![next(A, 1, 1)])).unwrap();
        assert_eq!(inbox.take().len(), 1, "duplicates are not broadcast");
        hub.send(unrelated, &connect(4, vec![])).unwrap();
        let received = inbox.take();
        let [(session, Body::Error { code, .. })] = &received[..] else {
            panic!("a session only serves its own document");
        };
        assert_eq!((*session, code.as_str()), (unrelated, "INVALID_MESSAGE"));
    }

    #[test]
    fn sessions_close_explicitly_by_owner_or_when_their_sink_is_gone() {
        let mut hub = hub();
        let inbox: Inbox = Rc::default();
        let a = hub.open("doc", "main", sink(&inbox, true)).unwrap();
        let b = hub.open("doc", "main", sink(&inbox, true)).unwrap();
        let dead = hub.open("doc", "other", sink(&inbox, false)).unwrap();
        hub.send(a, &upload(1, vec![next(A, 1, 1)])).unwrap();
        assert_eq!(
            hub.session_count(),
            2,
            "a failed broadcast drops the session"
        );
        assert_eq!(
            hub.send(dead, &connect(2, vec![])).unwrap_err().code,
            "CLOSED"
        );
        assert!(hub.close(b));
        assert!(!hub.close(b));
        assert_eq!(hub.send(b, &connect(3, vec![])).unwrap_err().code, "CLOSED");
        hub.open("doc", "main", sink(&inbox, true)).unwrap();
        assert_eq!(hub.close_owner("main"), 2);
        assert_eq!(hub.session_count(), 0);
        assert_eq!(
            hub.open("", "main", sink(&inbox, true)).unwrap_err().code,
            "INVALID_MESSAGE"
        );
    }

    #[test]
    fn invalid_frames_fail_the_call_but_keep_the_session() {
        let mut hub = hub();
        let inbox: Inbox = Rc::default();
        let session = hub.open("doc", "main", sink(&inbox, true)).unwrap();
        assert_eq!(
            hub.send(session, &[9, 3, 1]).unwrap_err().code,
            "UNSUPPORTED_VERSION"
        );
        hub.send(session, &connect(1, vec![])).unwrap();
        assert_eq!(inbox.borrow().len(), 1);
    }
}
