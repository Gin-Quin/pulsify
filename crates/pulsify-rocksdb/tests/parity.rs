//! One behaviour suite run against `RocksStore` and `SqliteStore`, then random
//! histories applied to both, which must answer identically.
use pulsify_protocol::{
    decode, encode, relay_frame, AppendResult, Body, Hub, Message, PatchRow, PatchStore,
    VersionVector, MAX_MESSAGE_ROWS, MAX_VECTOR_ENTRIES,
};
use pulsify_rocksdb::{RocksOptions, RocksStore};
use pulsify_sqlite::SqliteStore;
use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

const A: u64 = 65536;
const B: u64 = 65537;

fn row(sid: u64, clock: u64, span: u64, dependencies: &[(u64, u64)]) -> PatchRow {
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
fn next(sid: u64, clock: u64, span: u64) -> PatchRow {
    if clock == 1 {
        row(sid, 1, span, &[])
    } else {
        row(sid, clock, span, &[(sid, clock)])
    }
}
/// The code and message of a failure, whichever store it comes from.
fn failure<T, E: Into<pulsify_protocol::Error>>(result: Result<T, E>) -> (&'static str, String) {
    match result.map_err(Into::into) {
        Ok(_) => panic!("expected a failure"),
        Err(error) => (error.code, error.message),
    }
}
fn ok<T, E: Into<pulsify_protocol::Error>>(result: Result<T, E>) -> T {
    match result.map_err(Into::into) {
        Ok(value) => value,
        Err(error) => panic!("{error}"),
    }
}
/// Everything a store shows of "doc": its vector, its ready rows and how many are pending.
fn state<S: PatchStore>(store: &mut S, stored: &PatchRow) -> (VersionVector, Vec<PatchRow>, usize) {
    let resent = ok(store.append(std::slice::from_ref(stored)));
    assert_eq!(resent.inserted, 0);
    (
        ok(store.vector("doc")),
        ok(store.missing("doc", &vec![])),
        resent.pending,
    )
}

fn stores_and_reads_contiguous_rows<S: PatchStore>(mut store: S) {
    let result = ok(store.append(&[next(A, 1, 2), next(A, 3, 1), next(B, 1, 4)]));
    assert_eq!(
        result,
        AppendResult {
            inserted: 3,
            ready: 3,
            pending: 0,
            vector: Some(vec![(A, 4), (B, 5)]),
        }
    );
    assert_eq!(ok(store.vector("doc")), vec![(A, 4), (B, 5)]);
    assert_eq!(
        ok(store.missing("doc", &vec![])),
        vec![next(A, 1, 2), next(A, 3, 1), next(B, 1, 4)]
    );
    let missing = ok(store.missing("doc", &vec![(A, 3)]));
    assert_eq!(missing, vec![next(A, 3, 1), next(B, 1, 4)]);
    // A row straddling the remote clock is sent whole.
    assert_eq!(
        ok(store.missing("doc", &vec![(A, 2), (B, 3)])),
        vec![next(A, 1, 2), next(A, 3, 1), next(B, 1, 4)]
    );
    assert_eq!(
        ok(store.missing("doc", &vec![(A, 9), (B, 4)])),
        vec![next(B, 1, 4)]
    );
    assert!(ok(store.missing("doc", &vec![(A, 4), (B, 5)])).is_empty());
    assert!(ok(store.missing("other", &vec![])).is_empty());
    assert!(ok(store.vector("other")).is_empty());
    let (rows, vector) = ok(store.sync_state("doc", &vec![(A, 4)]));
    assert_eq!((rows, vector), (vec![next(B, 1, 4)], vec![(A, 4), (B, 5)]));
}

fn exact_duplicates_are_idempotent<S: PatchStore>(mut store: S) {
    ok(store.append(&[next(A, 1, 2)]));
    let again = ok(store.append(&[next(A, 1, 2), next(A, 1, 2)]));
    assert_eq!((again.inserted, again.ready, again.pending), (0, 0, 0));
    assert_eq!(again.vector, Some(vec![(A, 3)]));
    assert_eq!(ok(store.missing("doc", &vec![])).len(), 1);
    assert_eq!(ok(store.append(&[])), AppendResult::default());
    // Twice in the batch that first stores it.
    let twice = ok(store.append(&[next(B, 2, 1), next(B, 2, 1)]));
    assert_eq!((twice.inserted, twice.pending), (1, 1));
}

fn conflicts_roll_back_the_whole_batch<S: PatchStore>(mut store: S) {
    ok(store.append(&[next(A, 1, 2)]));
    let before = state(&mut store, &next(A, 1, 2));
    let mut changed = next(A, 1, 2);
    changed.operations = vec![9];
    let cases = [
        (changed, "Conflicting storage segment"),
        (next(A, 2, 2), "Overlapping immutable storage segments"),
        (row(A, 3, 1, &[(A, 2)]), "Actor history fork"),
    ];
    for (bad, message) in cases {
        // B's rows are valid: one ready, one pending. Neither is kept.
        let error = failure(store.append(&[next(B, 1, 1), next(B, 5, 1), bad]));
        assert_eq!(error, ("CONFLICT", message.to_owned()));
        assert_eq!(state(&mut store, &next(A, 1, 2)), before);
    }
    // Forks are detected against later neighbours and rows of the same batch.
    ok(store.append(&[row(A, 5, 1, &[(A, 3)])]));
    assert_eq!(
        failure(store.append(&[next(A, 3, 2)])).1,
        "Actor history fork"
    );
    let error = failure(store.append(&[next(A, 6, 1), row(A, 7, 1, &[(A, 4)])]));
    assert_eq!(error.1, "Actor history fork");
    assert_eq!(
        state(&mut store, &next(A, 1, 2)),
        (vec![(A, 3)], vec![next(A, 1, 2)], 1)
    );
}

fn gaps_and_missing_dependencies_stay_pending_until_promoted<S: PatchStore>(mut store: S) {
    let gap = ok(store.append(&[next(A, 3, 2)]));
    assert_eq!((gap.inserted, gap.ready, gap.pending), (1, 0, 1));
    let dependent = ok(store.append(&[row(B, 1, 1, &[(A, 5)])]));
    assert_eq!((dependent.ready, dependent.pending), (0, 2));
    assert!(ok(store.vector("doc")).is_empty());
    assert!(ok(store.missing("doc", &vec![])).is_empty());
    assert!(ok(store.missing("doc", &vec![(A, 3)])).is_empty());
    let filled = ok(store.append(&[next(A, 1, 2)]));
    assert_eq!((filled.inserted, filled.ready, filled.pending), (1, 3, 0));
    assert_eq!(ok(store.vector("doc")), vec![(A, 5), (B, 2)]);
    assert_eq!(
        ok(store.missing("doc", &vec![])),
        vec![next(A, 1, 2), next(A, 3, 2), row(B, 1, 1, &[(A, 5)])]
    );
    // A pending row after ready ones is not sent, with or without a remote clock.
    ok(store.append(&[next(A, 7, 1)]));
    assert_eq!(ok(store.missing("doc", &vec![])).len(), 3);
    assert_eq!(
        ok(store.missing("doc", &vec![(A, 4)])),
        vec![next(A, 3, 2), row(B, 1, 1, &[(A, 5)])]
    );
}

fn in_order_rows_skip_pending_and_keep_every_check<S: PatchStore>(mut store: S) {
    let batch: Vec<_> = (1..=5).map(|clock| next(A, clock, 1)).collect();
    let result = ok(store.append(&batch));
    assert_eq!((result.inserted, result.ready, result.pending), (5, 5, 0));
    assert_eq!(result.vector, Some(vec![(A, 6)]));
    // Resends stay idempotent, a different payload conflicts.
    assert_eq!(ok(store.append(&batch[1..3])).inserted, 0);
    let mut changed = next(A, 3, 1);
    changed.operations.push(0);
    assert_eq!(
        failure(store.append(&[changed])).1,
        "Conflicting storage segment"
    );
    // A fork at the frontier is caught without reading the previous row,
    // and rolls back the whole batch.
    for fork in [row(A, 6, 1, &[]), row(A, 6, 1, &[(A, 5)])] {
        let error = failure(store.append(&[next(B, 1, 1), fork]));
        assert_eq!(error.1, "Actor history fork");
    }
    assert_eq!(ok(store.vector("doc")), vec![(A, 6)]);
    // In-order rows of A while B has a pending row; an overlap with it conflicts.
    ok(store.append(&[next(B, 3, 1)]));
    let both = ok(store.append(&[next(A, 6, 1), next(B, 1, 2)]));
    assert_eq!((both.ready, both.pending), (3, 0));
    assert_eq!(both.vector, Some(vec![(A, 7), (B, 4)]));
    ok(store.append(&[next(B, 6, 1)]));
    assert_eq!(
        failure(store.append(&[next(B, 4, 3)])).1,
        "Overlapping immutable storage segments"
    );
}

fn rejects_invalid_rows_and_documents<S: PatchStore>(mut store: S) {
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
        assert_eq!(failure(store.append(&rows)).0, "INVALID_MESSAGE");
    }
    let too_many: Vec<_> = (1..=MAX_MESSAGE_ROWS as u64 + 1)
        .map(|clock| next(A, clock, 1))
        .collect();
    assert_eq!(failure(store.append(&too_many)).0, "LIMIT_EXCEEDED");
    for doc_id in ["", "a\0b", &"x".repeat(1025)] {
        assert_eq!(failure(store.vector(doc_id)).0, "INVALID_MESSAGE");
        assert_eq!(failure(store.missing(doc_id, &vec![])).0, "INVALID_MESSAGE");
        assert_eq!(
            failure(store.sync_state(doc_id, &vec![])).0,
            "INVALID_MESSAGE"
        );
    }
    let unsorted = vec![(B, 1), (A, 1)];
    assert_eq!(
        failure(store.missing("doc", &unsorted)).0,
        "INVALID_MESSAGE"
    );
    assert!(ok(store.missing("doc", &vec![])).is_empty());
    assert!(ok(store.vector("doc")).is_empty());
}

fn limits_the_number_of_actors<S: PatchStore>(mut store: S) {
    let rows: Vec<_> = (0..MAX_VECTOR_ENTRIES as u64)
        .map(|i| next(A + i, 1, 1))
        .collect();
    ok(store.append(&rows));
    // One more actor, ready or pending, is refused.
    for clock in [1, 2] {
        let error = failure(store.append(&[next(A + MAX_VECTOR_ENTRIES as u64, clock, 1)]));
        assert_eq!(
            error,
            ("LIMIT_EXCEEDED", "Document actor limit exceeded".to_owned())
        );
    }
    assert_eq!(ok(store.vector("doc")).len(), MAX_VECTOR_ENTRIES);
    assert_eq!(ok(store.missing("doc", &vec![])).len(), MAX_VECTOR_ENTRIES);
}

fn documents_are_separate<S: PatchStore>(mut store: S) {
    // IDs that are prefixes of each other, or differ by the lowest characters.
    let ids = ["do", "doc", "doc\u{1}", "doc\u{1}\u{1}", "docs", "d\u{ff}"];
    for (i, doc_id) in ids.iter().enumerate() {
        let mut rows = vec![next(A, 1, 1 + i as u64), next(B, 2, 1)];
        rows.iter_mut()
            .for_each(|row| row.doc_id = doc_id.to_string());
        let result = ok(store.append(&rows));
        assert_eq!((result.ready, result.pending), (1, 1));
    }
    for (i, doc_id) in ids.iter().enumerate() {
        assert_eq!(ok(store.vector(doc_id)), vec![(A, 2 + i as u64)]);
        for remote in [vec![], vec![(B, 1)]] {
            let rows = ok(store.missing(doc_id, &remote));
            assert_eq!(rows.len(), 1);
            assert_eq!(
                (rows[0].doc_id.as_str(), rows[0].span),
                (*doc_id, 1 + i as u64)
            );
        }
    }
}

fn frame(request_id: u64, body: Body) -> Vec<u8> {
    encode(&Message {
        doc_id: "doc".into(),
        request_id,
        body,
    })
    .unwrap()
}
fn connect(request_id: u64, vv: VersionVector) -> Vec<u8> {
    frame(request_id, Body::Connect { vv })
}
fn upload(request_id: u64, rows: Vec<PatchRow>) -> Vec<u8> {
    frame(request_id, Body::SyncBack { vv: vec![], rows })
}
fn bodies(frames: &[Vec<u8>]) -> Vec<(u64, Body)> {
    frames
        .iter()
        .map(|bytes| {
            let message = decode(bytes).unwrap();
            (message.request_id, message.body)
        })
        .collect()
}

fn relay_serves_connects_and_uploads<S: PatchStore>(mut store: S) {
    let output = ok(relay_frame(&mut store, &connect(1, vec![]), Some("doc")));
    assert_eq!(output.doc_id, "doc");
    assert!(output.broadcast.is_empty());
    let empty = Body::Sync {
        found: false,
        complete: true,
        vv: vec![],
        rows: vec![],
    };
    assert_eq!(bodies(&output.responses), vec![(1, empty)]);
    let rows = vec![next(A, 1, 2), next(A, 3, 1)];
    let output = ok(relay_frame(&mut store, &upload(2, rows.clone()), None));
    assert_eq!(
        bodies(&output.responses),
        vec![(2, Body::Ack { vv: vec![(A, 4)] })]
    );
    let update = Body::Update {
        vv: vec![(A, 4)],
        rows: rows.clone(),
    };
    assert_eq!(bodies(&output.broadcast), vec![(0, update)]);
    let update = frame(3, Body::Update { vv: vec![], rows });
    let again = ok(relay_frame(&mut store, &update, None));
    assert_eq!(
        bodies(&again.responses),
        vec![(3, Body::Ack { vv: vec![(A, 4)] })]
    );
    assert!(again.broadcast.is_empty());
    let sync = ok(relay_frame(&mut store, &connect(4, vec![(A, 3)]), None));
    let page = Body::Sync {
        found: true,
        complete: true,
        vv: vec![(A, 4)],
        rows: vec![next(A, 3, 1)],
    };
    assert_eq!(bodies(&sync.responses), vec![(4, page)]);
    // Pending rows are acknowledged without advancing the vector.
    let output = ok(relay_frame(
        &mut store,
        &upload(5, vec![next(B, 2, 1)]),
        None,
    ));
    assert_eq!(
        bodies(&output.responses),
        vec![(5, Body::Ack { vv: vec![(A, 4)] })]
    );
    assert_eq!(output.broadcast.len(), 1);
    let output = ok(relay_frame(
        &mut store,
        &upload(6, vec![next(B, 1, 1)]),
        None,
    ));
    let vv = vec![(A, 4), (B, 3)];
    assert_eq!(bodies(&output.responses), vec![(6, Body::Ack { vv })]);
}

fn relay_failures_become_error_frames<S: PatchStore>(mut store: S) {
    ok(relay_frame(
        &mut store,
        &upload(1, vec![next(A, 1, 2)]),
        None,
    ));
    let mut changed = next(A, 1, 2);
    changed.operations = vec![7];
    let cases = [
        (upload(2, vec![next(B, 1, 1), changed]), None, "CONFLICT"),
        (connect(3, vec![]), Some("other"), "INVALID_MESSAGE"),
        (
            frame(4, Body::Ack { vv: vec![] }),
            Some("doc"),
            "INVALID_MESSAGE",
        ),
    ];
    for (bytes, pinned, expected) in cases {
        let output = ok(relay_frame(&mut store, &bytes, pinned));
        assert!(output.broadcast.is_empty());
        let [(_, Body::Error { code, .. })] = &bodies(&output.responses)[..] else {
            panic!("expected one error frame");
        };
        assert_eq!(code, expected);
    }
    assert_eq!(ok(store.vector("doc")), vec![(A, 3)]);
    assert_eq!(
        failure(relay_frame(&mut store, &[1, 3, 9], None)).0,
        "INVALID_MESSAGE"
    );
    assert_eq!(
        failure(relay_frame(&mut store, &[9, 3, 1], None)).0,
        "UNSUPPORTED_VERSION"
    );
}

fn relay_pages_large_documents<S: PatchStore>(mut store: S) {
    let mut clock = 1;
    for _ in 0..3 {
        let rows: Vec<_> = (0..2)
            .map(|_| {
                let mut segment = next(A, clock, 1);
                segment.operations = vec![1; 700 * 1024];
                clock += 1;
                segment
            })
            .collect();
        ok(relay_frame(&mut store, &upload(1, rows), None));
    }
    let tiny: Vec<_> = (0..MAX_VECTOR_ENTRIES as u64 - 1)
        .map(|i| row(B + i, 1, 1, &[]))
        .collect();
    ok(relay_frame(&mut store, &upload(2, tiny), None));
    let output = ok(relay_frame(&mut store, &connect(3, vec![]), None));
    let pages = bodies(&output.responses);
    assert!(pages.len() >= 3);
    let mut total = 0;
    for (i, (request_id, body)) in pages.iter().enumerate() {
        let Body::Sync {
            found,
            complete,
            vv,
            rows,
        } = body
        else {
            panic!("expected sync pages");
        };
        assert_eq!(*request_id, 3);
        assert!(found);
        assert_eq!(*complete, i == pages.len() - 1);
        assert_eq!(vv.len(), MAX_VECTOR_ENTRIES);
        total += rows.len();
    }
    assert_eq!(total, 6 + MAX_VECTOR_ENTRIES - 1);
}

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

fn hub_broadcasts_and_closes_sessions<S: PatchStore>(store: S) {
    let mut hub: Hub<S, TestSink> = Hub::new(store);
    let inbox: Inbox = Rc::default();
    let first = ok(hub.open("doc", "main", sink(&inbox, true)));
    let second = ok(hub.open("doc", "other", sink(&inbox, true)));
    let unrelated = ok(hub.open("elsewhere", "main", sink(&inbox, true)));
    ok(hub.send(first, &connect(1, vec![])));
    assert_eq!(inbox.take().len(), 1);
    ok(hub.send(first, &upload(2, vec![next(A, 1, 1)])));
    let received = inbox.take();
    assert_eq!(received.len(), 2);
    assert_eq!(received[0], (first, Body::Ack { vv: vec![(A, 2)] }));
    assert_eq!(received[1].0, second);
    assert!(matches!(received[1].1, Body::Update { .. }));
    ok(hub.send(second, &upload(3, vec![next(A, 1, 1)])));
    assert_eq!(inbox.take().len(), 1, "duplicates are not broadcast");
    ok(hub.send(unrelated, &connect(4, vec![])));
    let received = inbox.take();
    let [(session, Body::Error { code, .. })] = &received[..] else {
        panic!("a session only serves its own document");
    };
    assert_eq!((*session, code.as_str()), (unrelated, "INVALID_MESSAGE"));
    assert_eq!(
        failure(hub.send(first, &[9, 3, 1])).0,
        "UNSUPPORTED_VERSION"
    );
    // A session closes explicitly, with its owner, or when its sink is gone.
    let dead = ok(hub.open("doc", "other", sink(&inbox, false)));
    ok(hub.send(first, &upload(5, vec![next(A, 2, 1)])));
    assert_eq!(
        hub.session_count(),
        3,
        "a failed broadcast drops the session"
    );
    assert_eq!(failure(hub.send(dead, &connect(6, vec![]))).0, "CLOSED");
    assert!(hub.close(second));
    assert!(!hub.close(second));
    assert_eq!(hub.close_owner("main"), 2);
    assert_eq!(hub.session_count(), 0);
    assert_eq!(
        failure(hub.open("", "main", sink(&inbox, true))).0,
        "INVALID_MESSAGE"
    );
    assert_eq!(ok(hub.store().vector("doc")), vec![(A, 3)]);
}

macro_rules! suite {
    ($store:ident, $make:expr, $($test:ident),+) => {
        mod $store {
            $(#[test]
            fn $test() {
                super::$test($make);
            })+
        }
    };
}
macro_rules! suites {
    ($($test:ident),+) => {
        suite!(rocksdb, pulsify_rocksdb::RocksStore::open_in_memory().unwrap(), $($test),+);
        suite!(sqlite, pulsify_sqlite::SqliteStore::open_in_memory().unwrap(), $($test),+);
    };
}
suites!(
    stores_and_reads_contiguous_rows,
    exact_duplicates_are_idempotent,
    conflicts_roll_back_the_whole_batch,
    gaps_and_missing_dependencies_stay_pending_until_promoted,
    in_order_rows_skip_pending_and_keep_every_check,
    rejects_invalid_rows_and_documents,
    limits_the_number_of_actors,
    documents_are_separate,
    relay_serves_connects_and_uploads,
    relay_failures_become_error_frames,
    relay_pages_large_documents,
    hub_broadcasts_and_closes_sessions
);

/// xorshift64*: deterministic, so a failing seed can be replayed.
struct Random(u64);
impl Random {
    fn below(&mut self, limit: u64) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 33) % limit
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }
}

/// A valid history: for each actor, contiguous rows that depend on the previous
/// one and sometimes on other actors.
fn history(random: &mut Random, doc_id: &str) -> Vec<Vec<PatchRow>> {
    let actors = 2 + random.below(3);
    let lengths: Vec<u64> = (0..actors).map(|_| 3 + random.below(9)).collect();
    (0..actors)
        .map(|actor| {
            let sid = A + actor;
            let mut clock = 1;
            (0..lengths[actor as usize])
                .map(|_| {
                    let span = 1 + random.below(3);
                    let mut dependencies = Vec::new();
                    for other in 0..actors {
                        if other == actor {
                            if clock > 1 {
                                dependencies.push((sid, clock));
                            }
                        } else if random.chance(25) {
                            // Sometimes beyond what the other actor will ever write.
                            dependencies
                                .push((A + other, 1 + random.below(lengths[other as usize] * 2)));
                        }
                    }
                    let operations = (0..1 + random.below(40))
                        .map(|_| random.below(256) as u8)
                        .collect();
                    let row = PatchRow {
                        doc_id: doc_id.to_owned(),
                        sid,
                        clock,
                        span,
                        dependencies,
                        operations,
                    };
                    clock += span;
                    row
                })
                .collect()
        })
        .collect()
}

/// A row that contradicts the history: another payload, an overlap or a fork.
fn mutant(random: &mut Random, mut row: PatchRow) -> PatchRow {
    match random.below(6) {
        0 => row.operations.push(1),
        1 => row.span += 1,
        2 if row.span > 1 => row.span -= 1,
        3 => row.clock += 1,
        4 if row.clock > 1 => {
            row.clock -= 1;
            row.dependencies
                .retain(|(sid, clock)| *sid != row.sid || *clock <= row.clock);
        }
        _ => row.dependencies.retain(|(sid, _)| *sid != row.sid),
    }
    row
}

fn directory(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("pulsify-rocksdb-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    path
}

#[test]
fn random_histories_match_sqlite() {
    let ids = ["doc", "doc\u{1}", "do"];
    let (mut appended, mut refused, mut promoted) = (0, 0, 0);
    for seed in 1..=120u64 {
        let mut random = Random(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        // Odd seeds use a database on disk that caches one document, is
        // flushed to files and reopened along the way.
        let path = (seed % 2 == 1).then(|| directory(&format!("random-{seed}")));
        let options = RocksOptions {
            sync: false,
            cached_documents: 1,
            ..RocksOptions::default()
        };
        let open = || match &path {
            Some(path) => RocksStore::open_with(path, &options).unwrap(),
            None => RocksStore::open_in_memory().unwrap(),
        };
        let mut rocks = Some(open());
        let mut sqlite = SqliteStore::open_in_memory().unwrap();
        let histories: Vec<_> = ids.iter().map(|id| history(&mut random, id)).collect();
        let mut sent = vec![[0usize; 5]; ids.len()];
        for step in 0..90 {
            let document = random.below(ids.len() as u64) as usize;
            let (doc_id, actors) = (ids[document], &histories[document]);
            let mut batch = Vec::new();
            for _ in 0..1 + random.below(5) {
                let actor = random.below(actors.len() as u64) as usize;
                let rows = &actors[actor];
                let next = &mut sent[document][actor];
                let row = if random.chance(55) && *next < rows.len() {
                    *next += 1;
                    rows[*next - 1].clone()
                } else {
                    rows[random.below(rows.len() as u64) as usize].clone()
                };
                batch.push(if random.chance(12) {
                    mutant(&mut random, row)
                } else {
                    row
                });
            }
            let store = rocks.as_mut().unwrap();
            let expected = sqlite.append(&batch).map_err(|e| (e.code, e.message));
            let actual = store.append(&batch).map_err(|e| (e.code, e.message));
            assert_eq!(actual, expected, "seed {seed}, step {step}: {batch:?}");
            match &expected {
                Ok(result) => {
                    appended += result.inserted;
                    promoted += result.ready;
                }
                Err(_) => refused += 1,
            }
            if path.is_some() && random.chance(10) {
                store.flush().unwrap();
            }
            if path.is_some() && random.chance(6) {
                drop(rocks.take());
                rocks = Some(open());
            }
            let store = rocks.as_mut().unwrap();
            let vector = sqlite.vector(doc_id).unwrap();
            assert_eq!(
                store.vector(doc_id).unwrap(),
                vector,
                "seed {seed}, step {step}"
            );
            let mut remotes = vec![vec![], vector.clone()];
            for _ in 0..3 {
                // Any actor of the history, known or not, at any clock.
                let mut remote = Vec::new();
                for actor in 0..actors.len() as u64 {
                    if random.chance(60) {
                        remote.push((A + actor, 1 + random.below(30)));
                    }
                }
                remotes.push(remote);
            }
            for remote in &remotes {
                let expected = sqlite.missing(doc_id, remote).unwrap();
                assert_eq!(
                    store.missing(doc_id, remote).unwrap(),
                    expected,
                    "seed {seed}, step {step}, remote {remote:?}"
                );
                let state = sqlite.sync_state(doc_id, remote).unwrap();
                assert_eq!(store.sync_state(doc_id, remote).unwrap(), state);
            }
        }
        drop(rocks);
        if let Some(path) = path {
            std::fs::remove_dir_all(path).unwrap();
        }
    }
    // The histories exercise every outcome, not only the easy one.
    assert!(appended > 2000 && refused > 500 && promoted > 1500);
}
