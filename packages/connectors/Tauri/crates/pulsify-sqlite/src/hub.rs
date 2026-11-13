//! `Hub` lives in `pulsify-protocol`; these tests run it on SQLite.
#[cfg(test)]
mod tests {
    use crate::relay::tests::{connect, upload};
    use crate::store::tests::{next, A};
    use crate::{Hub, SqliteStore};
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
