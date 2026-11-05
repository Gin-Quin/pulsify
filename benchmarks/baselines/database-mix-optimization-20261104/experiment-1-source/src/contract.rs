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
    session.cleanup(&prefix).unwrap();
}
