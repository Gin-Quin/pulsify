use crate::model::Segment;
use crate::storage;
use pulsify_protocol::PatchRow;
use std::time::{SystemTime, UNIX_EPOCH};
use storage::Session;

pub fn row(sid: u64, clock: u64, dependencies: Vec<(u64, u64)>) -> Segment {
    Segment::pack(
        vec![PatchRow {
            doc_id: "contract".into(),
            sid,
            clock,
            span: 1,
            dependencies,
            operations: vec![42, 239, 0, 255],
        }],
        false,
    )
    .unwrap()
}
pub fn verify(connect: impl Fn() -> Box<dyn Session> + Sync) {
    let prefix = format!(
        "contract-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let mut session = connect();
    storage::append(&mut *session, &prefix, &[row(70001, 1, vec![])]).unwrap();
    storage::append(&mut *session, &prefix, &[row(70001, 1, vec![])]).unwrap();
    assert_eq!(
        storage::read(&mut *session, &prefix, &vec![])
            .unwrap()
            .1
            .len(),
        1
    );
    let mut conflicting = row(70001, 1, vec![]).unpack().unwrap();
    conflicting[0].operations = vec![99];
    assert!(storage::append(
        &mut *session,
        &prefix,
        &[Segment::pack(conflicting, false).unwrap()]
    )
    .is_err());

    std::thread::scope(|scope| {
        for actor in 80000..80004 {
            let connect = &connect;
            let prefix = &prefix;
            scope.spawn(move || {
                let mut client = connect();
                for clock in 1..=12 {
                    let mut deps = vec![(70001, 2)];
                    if clock > 1 {
                        deps.push((actor, clock));
                    }
                    storage::append(&mut *client, prefix, &[row(actor, clock, deps)]).unwrap();
                }
            });
        }
    });
    let (state, rows) = storage::read(&mut *session, &prefix, &vec![]).unwrap();
    assert_eq!(rows.len(), 49);
    assert_eq!(
        state.vector,
        vec![
            (70001, 2),
            (80000, 13),
            (80001, 13),
            (80002, 13),
            (80003, 13)
        ]
    );
    let remote = vec![
        (70001, 2),
        (80000, 10),
        (80001, 10),
        (80002, 10),
        (80003, 10),
    ];
    let delta = storage::read(&mut *session, &prefix, &remote).unwrap().1;
    assert_eq!(delta.len(), 12);
    std::thread::scope(|scope| {
        for _ in 0..4 {
            let connect = &connect;
            let prefix = &prefix;
            scope.spawn(move || {
                storage::compact(&mut *connect(), prefix).unwrap();
            });
        }
    });
    assert_eq!(
        rows,
        storage::read(&mut *session, &prefix, &vec![]).unwrap().1
    );
    assert_eq!(
        delta,
        storage::read(&mut *session, &prefix, &remote).unwrap().1
    );
    assert!(storage::read(&mut *session, &prefix, &state.vector)
        .unwrap()
        .1
        .is_empty());
    let result = storage::append(
        &mut *session,
        &prefix,
        &[
            row(90000, 1, vec![(70001, 2)]),
            row(90000, 5, vec![(90000, 2)]),
        ],
    );
    assert!(result.is_err());
    assert_eq!(
        rows,
        storage::read(&mut *session, &prefix, &vec![]).unwrap().1
    );
    range_contract(&mut *session, &format!("{prefix}/range"));
    concurrent_compaction_contract(&connect, &format!("{prefix}/race"));
    session.cleanup(&prefix).unwrap();
}

// Exercise the bulk CAS with an append beyond the selected range, stale plans,
// payload/metadata conflicts and rollback after a failed range deletion.
fn range_contract(session: &mut dyn Session, doc: &str) {
    let seed: Vec<_> = (1..=33).map(|c| row(70001, c, vec![])).collect();
    storage::append(session, doc, &seed).unwrap();
    let sources = &seed[..32];
    storage::append(session, doc, &[row(70001, 34, vec![])]).unwrap();
    session
        .transact(doc, true, &mut |tx| {
            assert!(tx.matches(sources)?);
            let mut changed = sources.to_vec();
            changed[0].payload[0] ^= 1;
            assert!(!tx.matches(&changed)?);
            changed[0] = sources[0].clone();
            changed[0].dependencies.push((80000, 1));
            assert!(!tx.matches(&changed)?);
            let rows = sources.iter().flat_map(|s| s.unpack().unwrap()).collect();
            tx.remove(sources)?;
            tx.put(&Segment::pack(rows, true)?)?;
            Ok(storage::Output::default())
        })
        .unwrap();
    let (before, rows) = storage::read(session, doc, &vec![]).unwrap();
    assert_eq!(rows.len(), 34);
    assert_eq!(before.vector, vec![(70001, 35)]);
    session
        .transact(doc, true, &mut |tx| {
            assert!(!tx.matches(sources)?);
            Ok(storage::Output::default())
        })
        .unwrap();
    assert!(session
        .transact(doc, true, &mut |tx| {
            tx.remove(sources)?;
            Ok(storage::Output::default())
        })
        .is_err());
    assert_eq!(rows, storage::read(session, doc, &vec![]).unwrap().1);
}

fn concurrent_compaction_contract(connect: &(impl Fn() -> Box<dyn Session> + Sync), doc: &str) {
    let seed: Vec<_> = (1..=33).map(|c| row(70001, c, vec![])).collect();
    storage::append(&mut *connect(), doc, &seed).unwrap();
    let barrier = std::sync::Barrier::new(8);
    std::thread::scope(|scope| {
        for worker in 0..8 {
            let barrier = &barrier;
            scope.spawn(move || {
                let mut session = connect();
                barrier.wait();
                for c in 1..=24 {
                    if worker < 4 {
                        storage::append(
                            &mut *session,
                            doc,
                            &[row(80000 + worker, c, vec![(70001, 34)])],
                        )
                        .unwrap();
                    } else {
                        storage::compact(&mut *session, doc).unwrap();
                    }
                }
            });
        }
    });
    let mut expected: Vec<_> = seed.into_iter().flat_map(|s| s.unpack().unwrap()).collect();
    for actor in 80000..80004 {
        expected.extend((1..=24).flat_map(|c| row(actor, c, vec![(70001, 34)]).unpack().unwrap()));
    }
    assert_eq!(
        expected,
        storage::read(&mut *connect(), doc, &vec![]).unwrap().1
    );
}
