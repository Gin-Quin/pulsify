use super::*;
use crate::contract::{row, verify as contract};
use crate::model::Segment;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn sqlite_parallel_contract() {
    let path = std::env::temp_dir().join(format!(
        "pulsify-rust-test-{}.sqlite",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    storage::sqlite::Sqlite::initialize(path.to_str().unwrap()).unwrap();
    contract(|| Box::new(storage::sqlite::Sqlite::open(path.to_str().unwrap()).unwrap()));
    fs::remove_file(path).unwrap();
}
#[test]
fn real_postgres_parallel_contract() {
    if let Ok(url) = std::env::var("PULSIFY_NATIVE_PG_URL") {
        storage::pg::Pg::initialize(&url).unwrap();
        contract(|| Box::new(storage::pg::Pg::open(&url).unwrap()));
    }
}
#[test]
fn exact_mix_and_burst_work_are_not_lost() {
    let jobs = schedule("mixed", 400, "test", "spread", 8);
    for (op, count) in [
        ("write_patch", 180),
        ("read_delta", 100),
        ("write_full", 40),
        ("read_full", 40),
        ("compact", 40),
    ] {
        assert_eq!(jobs.iter().filter(|job| job.operation == op).count(), count);
    }
    assert_eq!(
        schedule("compact", 400, "test", "spread", 8)
            .iter()
            .map(|j| &j.doc)
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        400
    );
}
#[test]
fn compacted_segments_are_lossless_and_checked() {
    let rows = (1..30)
        .map(|c| {
            row(70001, c, if c == 1 { vec![] } else { vec![(70001, c)] })
                .unpack()
                .unwrap()
                .remove(0)
        })
        .collect::<Vec<_>>();
    let mut segment = Segment::pack(rows.clone(), true).unwrap();
    assert_eq!(segment.unpack().unwrap(), rows);
    segment.payload[0] ^= 1;
    assert!(segment.unpack().is_err());
}
