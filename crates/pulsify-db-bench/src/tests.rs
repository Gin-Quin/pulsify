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
fn scratch(name: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("pulsify-rust-test-{name}-{nanos}"));
    path.to_str().unwrap().to_owned()
}
#[test]
fn rocksdb_parallel_contract() {
    let path = scratch("rocksdb");
    let db = storage::rocks::open(&path, 64 << 20).unwrap();
    contract(|| Box::new(storage::rocks::Rocks(db.clone(), true)));
    drop(db);
    fs::remove_dir_all(path).unwrap();
}
#[test]
fn rocksdb_mutex_parallel_contract() {
    let path = scratch("rocksdb-mutex");
    let db = storage::rocks::open_plain(&path, 64 << 20).unwrap();
    contract(|| Box::new(storage::rocks::RocksMutex(db.clone(), true)));
    drop(db);
    fs::remove_dir_all(path).unwrap();
}
#[test]
fn leveldb_parallel_contract() {
    let path = scratch("leveldb");
    let db = storage::leveldb::open(&path, 64 << 20).unwrap();
    contract(|| Box::new(storage::leveldb::LevelDb(db.clone(), true)));
    drop(db);
    fs::remove_dir_all(path).unwrap();
}
#[test]
fn lmdb_parallel_contract() {
    for relaxed in [false, true] {
        let path = scratch("lmdb");
        let lmdb = storage::lmdb::open(&path, relaxed).unwrap();
        contract(|| Box::new(lmdb.clone()));
        drop(lmdb);
        fs::remove_dir_all(path).unwrap();
    }
}
// Valkey or Dragonfly, e.g. PULSIFY_NATIVE_RESP_URL=redis://127.0.0.1:6379
#[test]
fn real_resp_parallel_contract() {
    if let Ok(url) = std::env::var("PULSIFY_NATIVE_RESP_URL") {
        contract(|| Box::new(storage::resp::Resp::open(&url).unwrap()));
    }
}
// e.g. PULSIFY_NATIVE_SCYLLA_NODE=127.0.0.1:9042
#[test]
fn real_scylla_parallel_contract() {
    if let Ok(node) = std::env::var("PULSIFY_NATIVE_SCYLLA_NODE") {
        storage::scylla::Scylla::initialize(&node).unwrap();
        contract(|| Box::new(storage::scylla::Scylla::open(&node).unwrap()));
    }
}
// e.g. PULSIFY_NATIVE_CLICKHOUSE_URL=http://127.0.0.1:8123
#[test]
fn real_clickhouse_parallel_contract() {
    if let Ok(url) = std::env::var("PULSIFY_NATIVE_CLICKHOUSE_URL") {
        storage::clickhouse::ClickHouse::initialize(&url, false).unwrap();
        contract(|| Box::new(storage::clickhouse::ClickHouse::open(&url)));
    }
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
