//! One behaviour suite run against `RocksStore` and `SqliteStore`, then random
//! histories applied to both, which must answer identically.
use pulsify_protocol::{
    decode, encode, is_gap, last_register_of, relay_frame, AppendResult, Body, DocumentStore, Hub,
    Message, PatchLog, PatchRow, PatchStore, VersionVector, GAP_OPERATIONS, MAX_MESSAGE_ROWS,
    MAX_VECTOR_ENTRIES,
};
use pulsify_rocksdb::{RocksOptions, RocksStore};
use pulsify_sqlite::SqliteStore;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
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
fn varuint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 128 {
        out.push(value as u8 | 128);
        value >>= 7;
    }
    out.push(value as u8);
}
/// One kind 7 write of `sid` to the numeric field `field` of the node "n": a
/// last-value row. `tail` stands for its value.
fn write(sid: u64, clock: u64, lamport: u64, field: u8) -> PatchRow {
    let mut operations = vec![3];
    varuint(&mut operations, lamport);
    operations.extend([0, 1, 7, 1, b'n', 1, field, sid as u8, clock as u8]);
    PatchRow {
        operations,
        ..next(sid, clock, 1)
    }
}
/// What stays of replaced writes that no earlier row can cover.
fn gap(sid: u64, clock: u64, span: u64) -> PatchRow {
    PatchRow {
        operations: GAP_OPERATIONS.to_vec(),
        ..next(sid, clock, span)
    }
}
/// The ready rows of "doc": actor, start and span.
fn spans<S: PatchStore>(store: &S) -> Vec<(u64, u64, u64)> {
    ok(store.missing("doc", &vec![]))
        .iter()
        .map(|row| (row.sid, row.clock, row.span))
        .collect()
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
    // A row whose span covers a waiting row replaces it.
    ok(store.append(&[next(B, 6, 1)]));
    let wide = ok(store.append(&[next(B, 4, 3)]));
    assert_eq!((wide.inserted, wide.ready, wide.pending), (1, 1, 0));
    assert_eq!(wide.vector, Some(vec![(A, 7), (B, 7)]));
    assert_eq!(
        ok(store.missing("doc", &vec![(A, 7), (B, 4)])),
        vec![next(B, 4, 3)]
    );
}

fn a_register_rewritten_many_times_keeps_one_row_per_actor<S: PatchStore>(mut store: S) {
    ok(store.append(&[next(A, 1, 1), next(B, 1, 1)]));
    for clock in 2..=300u64 {
        // Two registers of A, one of which B also writes, with older times.
        let mine = ok(store.append(&[write(A, clock, 1000 + clock, (clock % 2) as u8)]));
        assert_eq!((mine.inserted, mine.ready, mine.pending), (1, 1, 0));
        let late = ok(store.append(&[write(B, clock, clock, 0)]));
        assert_eq!((late.inserted, late.ready), (1, 1));
        assert_eq!(late.vector, Some(vec![(A, clock + 1), (B, clock + 1)]));
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
    assert_eq!(
        ok(store.missing("doc", &vec![(A, 299), (B, 301)])),
        vec![write(A, 299, 1299, 1), write(A, 300, 1300, 0)]
    );
    // Sent again, whole or with the spans a peer holds, nothing changes.
    let mut again = ok(store.missing("doc", &vec![]));
    again.extend((2..=300).map(|clock| write(A, clock, 1000 + clock, (clock % 2) as u8)));
    assert_eq!(ok(store.append(&again)).inserted, 0);
    ok(store.append(&[write(B, 301, 2000, 0)]));
    ok(store.append(&[write(A, 301, 2000, 0)]));
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

fn every_actor_keeps_its_own_last_write<S: PatchStore>(mut store: S) {
    ok(store.append(&[next(A, 1, 1), write(A, 2, 9, 0)]));
    // An older write of another actor is kept: it is that actor's last one.
    let late = ok(store.append(&[next(B, 1, 1), write(B, 2, 3, 0)]));
    assert_eq!((late.inserted, late.ready, late.pending), (2, 2, 0));
    assert_eq!(
        spans(&store),
        vec![(A, 1, 1), (A, 2, 1), (B, 1, 1), (B, 2, 1)]
    );
    // On promotion: it waited for the row before it, and replaces B's value.
    let waiting = ok(store.append(&[write(B, 4, 4, 0), next(B, 5, 1)]));
    assert_eq!((waiting.ready, waiting.pending), (0, 2));
    let filled = ok(store.append(&[next(B, 3, 1)]));
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
    ok(store.append(&[write(B, 6, 10, 0)]));
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
    assert_eq!(ok(store.vector("doc")), vec![(A, 3), (B, 7)]);
    // Other kinds and transactions of several operations are history: kept.
    let mut several = write(A, 3, 50, 0);
    several.operations[3] = 2;
    let mut plain = write(A, 4, 50, 0);
    plain.operations[4] = 1;
    ok(store.append(&[several, plain]));
    assert_eq!(ok(store.missing("doc", &vec![])).len(), 8);
}

fn a_known_row_with_a_longer_span_moves_the_frontier<S: PatchStore>(mut store: S) {
    let (first, second) = (next(A, 1, 1), next(A, 2, 1));
    ok(store.append(&[first.clone(), second.clone()]));
    // The sender replaced two writes after the second one.
    let long = PatchRow {
        span: 3,
        ..second.clone()
    };
    let moved = ok(store.append(std::slice::from_ref(&long)));
    assert_eq!((moved.inserted, moved.ready, moved.pending), (1, 0, 0));
    assert_eq!(moved.vector, Some(vec![(A, 5)]));
    assert_eq!(ok(store.missing("doc", &vec![])), vec![first, long.clone()]);
    // Sent again, or shorter, it changes nothing; other contents conflict.
    for span in [1, 2, 3] {
        let again = PatchRow {
            span,
            ..second.clone()
        };
        assert_eq!(ok(store.append(&[again])).inserted, 0);
    }
    let changed = PatchRow {
        operations: vec![9],
        ..second.clone()
    };
    assert_eq!(
        failure(store.append(&[changed])),
        ("CONFLICT", "Conflicting storage segment".to_owned())
    );
    let after = next(A, 5, 1);
    assert_eq!(ok(store.append(std::slice::from_ref(&after))).ready, 1);
    assert_eq!(ok(store.missing("doc", &vec![(A, 3)])), vec![long, after]);
    // Beyond rows that wait: they were replaced, and the next one is promoted.
    ok(store.append(&[next(A, 8, 1), next(A, 10, 1)]));
    let wide = PatchRow {
        span: 9,
        ..next(A, 1, 1)
    };
    let moved = ok(store.append(&[wide]));
    assert_eq!((moved.inserted, moved.ready, moved.pending), (1, 1, 0));
    assert_eq!(
        spans(&store),
        vec![(A, 1, 1), (A, 2, 3), (A, 5, 5), (A, 10, 1)]
    );
    assert_eq!(ok(store.vector("doc")), vec![(A, 11)]);
}

fn a_row_replaces_the_waiting_rows_that_its_span_covers<S: PatchStore>(mut store: S) {
    // B's gap keeps its row pending beside in-order appends.
    ok(store.append(&[next(B, 3, 1)]));
    let both = ok(store.append(&[next(A, 1, 1), next(A, 2, 1)]));
    assert_eq!((both.ready, both.pending), (2, 1));
    // Its span says the writes that followed it were replaced.
    let long = next(B, 1, 3);
    let result = ok(store.append(std::slice::from_ref(&long)));
    assert_eq!((result.ready, result.pending), (1, 0));
    assert_eq!(ok(store.missing("doc", &vec![(A, 3)])), vec![long]);
    // Waiting rows inserted earlier in the same batch are replaced too.
    let wide = next(A, 3, 2);
    let result = ok(store.append(&[next(A, 4, 1), wide.clone()]));
    assert_eq!((result.inserted, result.ready, result.pending), (2, 1, 0));
    assert_eq!(ok(store.vector("doc")), vec![(A, 5), (B, 4)]);
    assert_eq!(
        ok(store.missing("doc", &vec![(B, 4)])),
        vec![next(A, 1, 1), next(A, 2, 1), wide]
    );
    // A waiting row that starts inside another waiting row's span is dropped,
    // and of two rows with the same start the longer span is kept.
    let result = ok(store.append(&[next(A, 7, 2), next(A, 8, 1), next(A, 10, 1), next(A, 12, 1)]));
    assert_eq!((result.inserted, result.pending), (3, 3));
    let mut longer = next(A, 7, 2);
    longer.span = 4;
    let result = ok(store.append(&[longer.clone(), next(A, 7, 2)]));
    assert_eq!((result.inserted, result.pending), (0, 2));
    let result = ok(store.append(&[next(A, 5, 2), next(A, 11, 1)]));
    assert_eq!((result.ready, result.pending), (4, 0));
    assert_eq!(
        ok(store.missing("doc", &vec![(A, 5), (B, 4)])),
        vec![next(A, 5, 2), longer, next(A, 11, 1), next(A, 12, 1)]
    );
}

fn a_waiting_row_that_learns_a_longer_span_replaces_the_rows_it_covers<S: PatchStore>(
    mut store: S,
) {
    let (fifth, sixth) = (next(A, 5, 1), next(A, 6, 1));
    assert_eq!(ok(store.append(&[fifth.clone(), sixth.clone()])).pending, 2);
    let longer = PatchRow {
        span: 3,
        ..fifth.clone()
    };
    let grown = ok(store.append(std::slice::from_ref(&longer)));
    assert_eq!((grown.inserted, grown.pending), (0, 1));
    let first = next(A, 1, 4);
    let filled = ok(store.append(std::slice::from_ref(&first)));
    assert_eq!((filled.ready, filled.pending), (2, 0));
    assert_eq!(ok(store.vector("doc")), vec![(A, 8)]);
    assert_eq!(ok(store.missing("doc", &vec![])), vec![first, longer]);
    // What it replaced is ignored when it comes again, whatever it holds.
    let changed = PatchRow {
        operations: vec![9],
        ..sixth
    };
    assert_eq!(ok(store.append(&[changed])).inserted, 0);
}

fn the_first_row_past_a_span_must_build_on_it<S: PatchStore>(mut store: S) {
    // Waiting rows: the second one says its actor's history ended at 7.
    ok(store.append(&[next(A, 6, 1), row(A, 9, 1, &[(A, 7)])]));
    assert_eq!(
        failure(store.append(&[next(A, 5, 3)])),
        ("CONFLICT", "Actor history fork".to_owned())
    );
    // The refused batch left the waiting rows as they were.
    let again = ok(store.append(&[next(A, 6, 1)]));
    assert_eq!((again.inserted, again.pending), (0, 2));
    // A row that builds on the span is accepted, and replaces what it covers.
    let wide = ok(store.append(&[next(A, 5, 2)]));
    assert_eq!((wide.inserted, wide.pending), (1, 2));
    let filled = ok(store.append(&[next(A, 1, 4)]));
    assert_eq!((filled.ready, filled.pending), (2, 1));
    assert_eq!(ok(store.vector("doc")), vec![(A, 7)]);
}

fn replaced_writes_are_served_as_gap_rows<S: PatchStore>(mut store: S) {
    ok(store.append(&[write(A, 1, 1, 0)]));
    ok(store.append(&[write(B, 1, 2, 0)]));
    assert_eq!(
        ok(store.missing("doc", &vec![])),
        vec![write(A, 1, 1, 0), write(B, 1, 2, 0)]
    );
    // Nothing holds A's first sequence numbers any more: a gap row stands for them.
    ok(store.append(&[write(A, 2, 1, 0), write(A, 3, 1, 0)]));
    assert_eq!(
        ok(store.missing("doc", &vec![(B, 2)])),
        vec![gap(A, 1, 2), write(A, 3, 1, 0)]
    );
    assert_eq!(
        ok(store.missing("doc", &vec![(A, 3), (B, 2)])),
        vec![write(A, 3, 1, 0)]
    );
    // A peer sends a gap row where this store holds a row, and the reverse:
    // neither is a conflict, and the row that is held stays.
    let result = ok(store.append(&[gap(B, 1, 1), write(A, 1, 1, 0)]));
    assert_eq!(result.inserted, 0);
    assert_eq!(
        ok(store.missing("doc", &vec![(A, 4)])),
        vec![write(B, 1, 2, 0)]
    );
    // A gap row that arrives only moves the frontier.
    ok(store.append(&[gap(B, 2, 3), gap(A + 2, 1, 2)]));
    assert_eq!(
        spans(&store),
        vec![(A, 1, 2), (A, 3, 1), (B, 1, 4), (A + 2, 1, 2)]
    );
    assert_eq!(ok(store.vector("doc")), vec![(A, 4), (B, 5), (A + 2, 3)]);
    // A first row replaced in the batch that brings it.
    ok(store.append(&[write(A + 3, 1, 1, 0), write(A + 3, 2, 1, 0)]));
    assert_eq!(
        ok(store.missing("doc", &vec![(A, 4), (B, 5), (A + 2, 3)])),
        vec![gap(A + 3, 1, 1), write(A + 3, 2, 1, 0)]
    );
}

fn other_contents_at_a_stored_identity_still_conflict<S: PatchStore>(mut store: S) {
    ok(store.append(&[next(A, 1, 1), write(A, 2, 5, 0), next(A, 5, 2)]));
    let before = state(&mut store, &next(A, 1, 1));
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
        let error = failure(store.append(&[next(B, 1, 1), bad]));
        assert_eq!(
            error,
            ("CONFLICT", "Conflicting storage segment".to_owned())
        );
        assert_eq!(state(&mut store, &next(A, 1, 1)), before);
    }
    // Once replaced, a row is no longer compared: its sequence number holds nothing.
    ok(store.append(&[write(A, 3, 6, 0)]));
    assert_eq!(spans(&store), vec![(A, 1, 2), (A, 3, 1)]);
    let replaced = changed(write(A, 2, 5, 0));
    assert_eq!(ok(store.append(&[replaced])).inserted, 0);
    assert_eq!(
        failure(store.append(&[changed(next(A, 1, 2))])).0,
        "CONFLICT"
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

fn relay_forwards_whatever_an_upload_made_applicable<S: PatchStore>(mut store: S) {
    ok(relay_frame(
        &mut store,
        &upload(1, vec![next(A, 1, 1), write(A, 2, 5, 0)]),
        None,
    ));
    // Another actor's write to the register is kept beside A's, and the
    // upload is forwarded as it was received.
    let newer = vec![write(B, 1, 6, 0)];
    let output = ok(relay_frame(&mut store, &upload(2, newer.clone()), None));
    assert_eq!(ok(store.missing("doc", &vec![])).len(), 3);
    let vv = vec![(A, 3), (B, 2)];
    assert_eq!(
        bodies(&output.responses),
        vec![(2, Body::Ack { vv: vv.clone() })]
    );
    assert_eq!(
        bodies(&output.broadcast),
        vec![(0, Body::Update { vv, rows: newer })]
    );
    // A's next write to it replaces A's own, whatever its time.
    let older = vec![write(A, 3, 1, 0)];
    let output = ok(relay_frame(&mut store, &upload(3, older.clone()), None));
    assert_eq!(ok(store.missing("doc", &vec![])).len(), 3);
    let vv = vec![(A, 4), (B, 2)];
    assert_eq!(
        bodies(&output.broadcast),
        vec![(0, Body::Update { vv, rows: older })]
    );
    // A known row whose span covers more replaced writes moves the frontier;
    // sent again, nothing.
    let long = vec![PatchRow {
        span: 6,
        ..next(A, 1, 1)
    }];
    let output = ok(relay_frame(&mut store, &upload(4, long.clone()), None));
    let vv = vec![(A, 7), (B, 2)];
    assert_eq!(
        bodies(&output.responses),
        vec![(4, Body::Ack { vv: vv.clone() })]
    );
    assert_eq!(
        bodies(&output.broadcast),
        vec![(
            0,
            Body::Update {
                vv,
                rows: long.clone()
            }
        )]
    );
    let again = ok(relay_frame(&mut store, &upload(5, long), None));
    assert!(again.broadcast.is_empty());
    // A new peer gets what is held, with spans that cover the replaced writes.
    let sync = ok(relay_frame(&mut store, &connect(6, vec![]), None));
    let page = Body::Sync {
        found: true,
        complete: true,
        vv: vec![(A, 7), (B, 2)],
        rows: vec![
            PatchRow {
                span: 2,
                ..next(A, 1, 1)
            },
            PatchRow {
                span: 4,
                ..write(A, 3, 1, 0)
            },
            write(B, 1, 6, 0),
        ],
    };
    assert_eq!(bodies(&sync.responses), vec![(6, page)]);
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
    a_register_rewritten_many_times_keeps_one_row_per_actor,
    every_actor_keeps_its_own_last_write,
    a_known_row_with_a_longer_span_moves_the_frontier,
    a_row_replaces_the_waiting_rows_that_its_span_covers,
    a_waiting_row_that_learns_a_longer_span_replaces_the_rows_it_covers,
    the_first_row_past_a_span_must_build_on_it,
    replaced_writes_are_served_as_gap_rows,
    other_contents_at_a_stored_identity_still_conflict,
    rejects_invalid_rows_and_documents,
    limits_the_number_of_actors,
    documents_are_separate,
    deletion_is_permanent_and_scoped,
    deletion_can_preserve_recovery_rows,
    relay_serves_connects_and_uploads,
    relay_forwards_whatever_an_upload_made_applicable,
    relay_failures_become_error_frames,
    relay_pages_large_documents,
    hub_broadcasts_and_closes_sessions,
    hub_deletion_stops_only_covered_sessions
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
                    let mut operations: Vec<u8> = (0..1 + random.below(40))
                        .map(|_| random.below(256) as u8)
                        .collect();
                    // Often a write to one of a few registers without history,
                    // at a time unrelated to its place in the actor's history.
                    if random.chance(45) {
                        let head = [
                            3,
                            1 + random.below(40) as u8,
                            0,
                            1,
                            7 + random.below(2) as u8,
                        ];
                        operations.splice(
                            ..0,
                            head.into_iter().chain([1, b'n', 1, random.below(3) as u8]),
                        );
                    }
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

/// A row that differs from the history: another payload, a fork, or what a
/// peer that replaced writes would send, a longer span or a gap row.
fn mutant(random: &mut Random, mut row: PatchRow) -> PatchRow {
    match random.below(9) {
        0 => row.operations.push(1),
        1 => row.span += 1,
        6 => row.span += 1 + random.below(6),
        7 => row.operations = GAP_OPERATIONS.to_vec(),
        8 => {
            row.operations = GAP_OPERATIONS.to_vec();
            row.span += random.below(4);
        }
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
                batch.push(if random.chance(14) {
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
    assert!(
        appended > 2000 && refused > 500 && promoted > 1500,
        "{appended} appended, {refused} refused, {promoted} promoted"
    );
}

/// The Lamport time at the head of a payload of this file.
fn lamport_of(row: &PatchRow) -> u64 {
    if is_gap(&row.operations) {
        return 0;
    }
    let (mut value, mut shift) = (0, 0);
    for byte in &row.operations[1..] {
        value |= u64::from(byte & 127) << shift;
        shift += 7;
        if *byte < 128 {
            break;
        }
    }
    value
}

/// A replica: its journal, and the Lamport time of what it has seen.
struct Peer {
    sid: u64,
    log: PatchLog,
    lamport: u64,
}
impl Peer {
    /// One transaction: a write to a register without history, or one that is kept.
    fn write(&mut self, random: &mut Random) -> PatchRow {
        let vector = self.log.vector();
        let clock = vector
            .iter()
            .find(|entry| entry.0 == self.sid)
            .map_or(1, |entry| entry.1);
        self.lamport += 1;
        let mut dependencies = Vec::new();
        for (actor, reached) in vector {
            if actor == self.sid || random.chance(30) {
                dependencies.push((actor, reached));
            }
        }
        let mut operations = vec![3];
        varuint(&mut operations, self.lamport);
        if random.chance(65) {
            operations.extend([0, 1, 7 + random.below(2) as u8, 1, b'n', 1]);
            operations.push(random.below(4) as u8);
        } else {
            operations.extend([0, 1, 3]);
        }
        operations.extend((0..random.below(12)).map(|_| random.below(256) as u8));
        let row = PatchRow {
            doc_id: "doc".into(),
            sid: self.sid,
            clock,
            span: 1,
            dependencies,
            operations,
        };
        self.log.append(std::slice::from_ref(&row)).unwrap();
        row
    }
    fn receive(&mut self, rows: &[PatchRow]) {
        self.log.append(rows).unwrap();
        let seen = rows.iter().map(lamport_of).max().unwrap_or(0);
        self.lamport = self.lamport.max(seen);
    }
}

/// The rows that still hold operations: identity and payload.
fn kept(rows: Vec<PatchRow>) -> BTreeMap<(u64, u64), Vec<u8>> {
    rows.into_iter()
        .filter(|row| !is_gap(&row.operations))
        .map(|row| ((row.sid, row.clock), row.operations))
        .collect()
}

/// A peer uploads what the stores lack, or downloads what it lacks. Returns
/// how many rows wait in the stores afterwards.
fn exchange(
    rocks: &mut RocksStore,
    sqlite: &mut SqliteStore,
    peer: &mut Peer,
    push: Option<bool>,
    context: &str,
) -> usize {
    let mut waiting = 0;
    if let Some(own) = push {
        // What the store lacks, as the journal holds it now: everything, or
        // the peer's own rows only, which then wait for those they build on.
        let mut rows = peer.log.missing(&sqlite.vector("doc").unwrap());
        rows.retain(|row| !own || row.sid == peer.sid);
        if rows.is_empty() {
            return 0;
        }
        let expected = sqlite.append(&rows).unwrap();
        let actual = rocks.append(&rows).unwrap();
        assert_eq!(actual, expected, "{context}: {rows:?}");
        waiting = expected.pending;
    } else {
        let rows = sqlite.missing("doc", &peer.log.vector()).unwrap();
        peer.receive(&rows);
    }
    let vector = sqlite.vector("doc").unwrap();
    assert_eq!(rocks.vector("doc").unwrap(), vector);
    let held = sqlite.missing("doc", &vec![]).unwrap();
    assert_eq!(rocks.missing("doc", &vec![]).unwrap(), held, "{context}");
    // The rows cover every sequence number of every actor exactly once.
    let mut next = BTreeMap::new();
    for row in &held {
        assert_eq!(row.clock, next.get(&row.sid).copied().unwrap_or(1));
        next.insert(row.sid, row.end());
    }
    assert_eq!(next.into_iter().collect::<Vec<_>>(), vector);
    let behind = peer.log.vector();
    assert_eq!(
        rocks.missing("doc", &behind).unwrap(),
        sqlite.missing("doc", &behind).unwrap()
    );
    waiting
}

/// Replicas that write concurrently and exchange what they hold through both
/// stores: the journal of `pulsify-protocol` keeps one row per register
/// without history, the stores at most one per actor and register, and a
/// replica that loads from them reaches the same journal.
#[test]
fn random_peers_converge_through_both_stores() {
    let (mut written, mut stored, mut waited) = (0, 0, 0);
    for seed in 1..=60u64 {
        let mut random = Random(seed.wrapping_mul(0xD6E8_FEB8_6659_FD93));
        let path = (seed % 3 == 1).then(|| directory(&format!("peers-{seed}")));
        let options = RocksOptions {
            sync: false,
            cached_documents: (seed % 2) as usize,
            ..RocksOptions::default()
        };
        let mut rocks = match &path {
            Some(path) => RocksStore::open_with(path, &options).unwrap(),
            None => RocksStore::open_in_memory().unwrap(),
        };
        let mut sqlite = SqliteStore::open_in_memory().unwrap();
        let mut peers: Vec<Peer> = (0..2 + random.below(3))
            .map(|i| Peer {
                sid: A + i,
                log: PatchLog::new("doc"),
                lamport: 0,
            })
            .collect();
        let mut authored = Vec::new();
        for step in 0..260 {
            let at = random.below(peers.len() as u64) as usize;
            let context = format!("seed {seed}, step {step}");
            let push = match random.below(8) {
                0..=2 => {
                    authored.push(peers[at].write(&mut random));
                    continue;
                }
                // Straight from another peer, behind the stores' back.
                3 | 4 => {
                    let other = random.below(peers.len() as u64) as usize;
                    let rows = peers[other].log.missing(&peers[at].log.vector());
                    peers[at].receive(&rows);
                    continue;
                }
                5 => Some(true),
                6 => Some(false),
                _ => None,
            };
            waited += exchange(&mut rocks, &mut sqlite, &mut peers[at], push, &context);
            if path.is_some() && random.chance(5) {
                rocks.flush().unwrap();
            }
        }
        for round in 0..3 {
            for peer in peers.iter_mut() {
                let context = format!("seed {seed}, round {round}");
                exchange(&mut rocks, &mut sqlite, peer, Some(false), &context);
                exchange(&mut rocks, &mut sqlite, peer, None, &context);
            }
        }
        // What a journal keeps: every kept transaction, and the newest write
        // of each register. A store keeps that, and besides at most one write
        // of each actor to a register: its newest one that reached the store.
        let mut expected = BTreeMap::new();
        let mut winners: BTreeMap<Vec<u8>, (u64, u64, u64)> = BTreeMap::new();
        let mut registers = BTreeMap::new();
        for row in &authored {
            match last_register_of(&row.operations) {
                Some(last) => {
                    let candidate = (last.lamport, row.sid, row.clock);
                    let winner = winners.entry(last.register.to_vec()).or_insert(candidate);
                    *winner = (*winner).max(candidate);
                    registers.insert((row.sid, row.clock), last.register.to_vec());
                }
                None => {
                    expected.insert((row.sid, row.clock), row.operations.clone());
                }
            }
        }
        let winners: BTreeSet<(u64, u64)> = winners.values().map(|w| (w.1, w.2)).collect();
        for row in &authored {
            if winners.contains(&(row.sid, row.clock)) {
                expected.insert((row.sid, row.clock), row.operations.clone());
            }
        }
        let vector = sqlite.vector("doc").unwrap();
        let held = sqlite.missing("doc", &vec![]).unwrap();
        written += authored.len();
        stored += held.len();
        let held = kept(held);
        for (key, operations) in &expected {
            assert_eq!(held.get(key), Some(operations), "seed {seed}");
        }
        let mut values = BTreeSet::new();
        for key in held.keys() {
            if let Some(register) = registers.get(key) {
                assert!(values.insert((key.0, register)), "seed {seed}: {key:?}");
            } else {
                assert!(expected.contains_key(key), "seed {seed}: {key:?}");
            }
        }
        for peer in &peers {
            assert_eq!(peer.log.vector(), vector, "seed {seed}");
            assert_eq!(peer.log.pending_count(), 0);
            assert_eq!(kept(peer.log.missing(&vec![])), expected, "seed {seed}");
        }
        // A replica that starts now reaches the same journal.
        let mut late = PatchLog::new("doc");
        late.append(&rocks.missing("doc", &vec![]).unwrap())
            .unwrap();
        assert_eq!(late.vector(), vector);
        assert_eq!(kept(late.missing(&vec![])), expected);
        drop(rocks);
        if let Some(path) = path {
            std::fs::remove_dir_all(path).unwrap();
        }
    }
    // Most writes were replaced, and some rows waited for others.
    assert!(
        written > 4000 && stored * 2 < written && waited > 50,
        "{written} written, {stored} stored, {waited} waited"
    );
}

fn deletion_is_permanent_and_scoped<T: DocumentStore>(mut store: T) {
    let ids = [
        "doc",
        "doc/a",
        "doc/a/child",
        "doc/ab",
        "doc/a0",
        "doc/b",
        "doc/é",
        "other",
    ];
    for id in ids {
        let mut r = next(A, 1, 1);
        r.doc_id = id.into();
        ok(store.append(&[r]));
    }
    assert_eq!(
        ok(store.documents("doc/a", "", 256)),
        vec!["doc/a", "doc/a/child"]
    );
    // Prime both native stores' read paths before deletion.
    ok(store.sync_state("doc/a/child", &vec![]));
    let mut pending = next(A, 5, 1);
    pending.doc_id = "doc/a/pending".into();
    ok(store.append(&[pending]));
    assert_eq!(ok(store.delete_documents("doc/a", false)), 3);
    assert_eq!(ok(store.delete_documents("doc/a", false)), 0);
    for id in ["doc/a", "doc/a/child", "doc/a/pending", "doc/a/never/seen"] {
        assert!(ok(store.is_deleted(id)));
        assert_eq!(failure(store.vector(id)).0, "NOT_FOUND");
        assert_eq!(failure(store.missing(id, &vec![])).0, "NOT_FOUND");
        assert_eq!(failure(store.sync_state(id, &vec![])).0, "NOT_FOUND");
        let mut r = next(B, 1, 1);
        r.doc_id = id.into();
        assert_eq!(failure(store.append(&[r])).0, "NOT_FOUND");
        assert!(ok(store.recover_rows(id)).is_empty());
    }
    assert_eq!(
        ok(store.documents("doc", "", 256)),
        vec!["doc", "doc/a0", "doc/ab", "doc/b", "doc/é"]
    );
    assert_eq!(ok(store.documents("doc", "doc/a0", 1)), vec!["doc/ab"]);
    for id in ["doc", "doc/ab", "doc/a0", "doc/b", "other"] {
        assert!(!ok(store.is_deleted(id)));
        let mut r = next(A, 2, 1);
        r.doc_id = id.into();
        ok(store.append(&[r]));
    }
    assert_eq!(ok(store.vector("never")), vec![]);
    // Deleting a parent subsumes the child marker and blocks future descendants.
    ok(store.delete_documents("doc", false));
    assert!(ok(store.is_deleted("doc/new")));
    assert_eq!(failure(store.documents("doc", "", 1)).0, "NOT_FOUND");
}
fn deletion_can_preserve_recovery_rows<T: DocumentStore>(mut store: T) {
    let original = next(A, 1, 1);
    ok(store.append(std::slice::from_ref(&original)));
    ok(store.delete_documents("doc", true));
    assert_eq!(ok(store.recover_rows("doc")), vec![original]);
    assert_eq!(failure(store.vector("doc")).0, "NOT_FOUND");
    assert_eq!(failure(store.append(&[next(A, 2, 1)])).0, "NOT_FOUND");
    // Explicitly discarding recovery data cannot clear the deletion marker.
    ok(store.delete_documents("doc", false));
    assert!(ok(store.recover_rows("doc")).is_empty());
    assert!(ok(store.is_deleted("doc/new")));
}
#[test]
fn deletion_survives_native_store_reopen() {
    let path = directory("tombstones");
    std::fs::create_dir_all(&path).unwrap();
    {
        let mut rocks = RocksStore::open_with(
            path.join("rocks"),
            &RocksOptions {
                sync: false,
                ..RocksOptions::default()
            },
        )
        .unwrap();
        let mut sqlite = SqliteStore::open(path.join("sqlite")).unwrap();
        rocks.append(&[next(A, 1, 1)]).unwrap();
        sqlite.append(&[next(A, 1, 1)]).unwrap();
        rocks.delete_documents("doc", true).unwrap();
        sqlite.delete_documents("doc", true).unwrap();
        rocks.flush().unwrap();
    }
    let mut rocks = RocksStore::open(path.join("rocks")).unwrap();
    let mut sqlite = SqliteStore::open(path.join("sqlite")).unwrap();
    assert!(rocks.is_deleted("doc/offline").unwrap());
    assert!(sqlite.is_deleted("doc/offline").unwrap());
    assert_eq!(failure(rocks.append(&[next(B, 1, 1)])).0, "NOT_FOUND");
    assert_eq!(failure(sqlite.append(&[next(B, 1, 1)])).0, "NOT_FOUND");
    assert_eq!(
        rocks.recover_rows("doc").unwrap(),
        sqlite.recover_rows("doc").unwrap()
    );
    drop(rocks);
    drop(sqlite);
    std::fs::remove_dir_all(path).unwrap();
}
#[test]
fn sqlite_concurrent_delete_and_append_cannot_resurrect() {
    use std::sync::{Arc, Barrier};
    let path = directory("concurrent-delete");
    std::fs::create_dir_all(&path).unwrap();
    let db = path.join("db");
    let mut first = SqliteStore::open(&db).unwrap();
    first.append(&[next(A, 1, 1)]).unwrap();
    let mut second = SqliteStore::open(&db).unwrap();
    let barrier = Arc::new(Barrier::new(2));
    let other = barrier.clone();
    let writer = std::thread::spawn(move || {
        other.wait();
        second.append(&[next(A, 2, 1)])
    });
    barrier.wait();
    first.delete_documents("doc", false).unwrap();
    if let Err(error) = writer.join().unwrap() {
        assert_eq!(error.code, "NOT_FOUND");
    }
    assert!(first.recover_rows("doc").unwrap().is_empty());
    assert_eq!(first.vector("doc").unwrap_err().code, "NOT_FOUND");
    drop(first);
    std::fs::remove_dir_all(path).unwrap();
}

fn hub_deletion_stops_only_covered_sessions<T: DocumentStore>(store: T) {
    let mut hub: Hub<T, TestSink> = Hub::new(store);
    let inbox: Inbox = Rc::default();
    let killed = ok(hub.open("doc/a", "one", sink(&inbox, true)));
    let nested = ok(hub.open("doc/a/b", "two", sink(&inbox, true)));
    let sibling = ok(hub.open("doc/ab", "three", sink(&inbox, true)));
    assert_eq!(ok(hub.delete_documents("doc/a", false)), 0);
    let messages = inbox.take();
    assert_eq!(messages.len(), 2);
    assert!(messages
        .iter()
        .all(|(_, body)| matches!(body, Body::Error {code, ..} if code == "NOT_FOUND")));
    assert_eq!(hub.session_count(), 1);
    assert_eq!(failure(hub.send(killed, &connect(1, vec![]))).0, "CLOSED");
    assert_eq!(failure(hub.send(nested, &connect(1, vec![]))).0, "CLOSED");
    assert!(hub.close(sibling));
}
#[test]
fn rocks_subtree_scan_crosses_sst_document_prefixes() {
    let path = directory("subtree-sst");
    let mut store = RocksStore::open(&path).unwrap();
    for id in ["doc/a", "doc/a/b", "doc/a/c", "doc/ab"] {
        let mut r = next(A, 1, 1);
        r.doc_id = id.into();
        store.append(&[r]).unwrap();
    }
    store.flush().unwrap();
    assert_eq!(
        store.documents("doc/a", "", 256).unwrap(),
        vec!["doc/a", "doc/a/b", "doc/a/c"]
    );
    store.delete_documents("doc/a/b", true).unwrap();
    store.flush().unwrap();
    assert_eq!(
        store.documents("doc/a", "", 256).unwrap(),
        vec!["doc/a", "doc/a/c"]
    );
    drop(store);
    std::fs::remove_dir_all(path).unwrap();
}

fn paged_subtree_starts_after_cursor<T: DocumentStore>(mut store: T) {
    let ids = [
        "doc/a",
        "doc/a/",
        "doc/a//x",
        "doc/a/0",
        "doc/a/keep",
        "doc/a/z",
        "doc/a-/sibling",
        "doc/ab",
        "other",
    ];
    for id in ids {
        for sid in [A, B] {
            let mut row = next(sid, 1, 1);
            row.doc_id = id.to_owned();
            ok(store.append(&[row]));
        }
    }
    ok(store.delete_documents("doc/a/0", true));
    for after in [
        "", "doc", "doc/a", "doc/a-", "doc/a/", "doc/a//x", "doc/a/y", "doc/a0", "zzz",
    ] {
        let mut expected: Vec<_> = ids
            .into_iter()
            .filter(|id| {
                pulsify_protocol::covers_document("doc/a", id) && *id != "doc/a/0" && *id > after
            })
            .collect();
        expected.sort();
        let mut found = Vec::new();
        let mut cursor = after.to_owned();
        loop {
            let page = ok(store.documents("doc/a", &cursor, 2));
            let Some(last) = page.last() else {
                break;
            };
            cursor = last.clone();
            found.extend(page);
        }
        assert_eq!(found, expected);
    }
}

#[test]
fn sqlite_paged_subtree_cursor_boundaries() {
    paged_subtree_starts_after_cursor(SqliteStore::open_in_memory().unwrap());
}

#[test]
fn rocks_paged_subtree_cursor_boundaries() {
    let path = directory("paged-subtree-cursors");
    paged_subtree_starts_after_cursor(RocksStore::open(&path).unwrap());
    std::fs::remove_dir_all(path).unwrap();
}
