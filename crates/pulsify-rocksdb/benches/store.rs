//! `cargo bench`: `RocksStore` next to `SqliteStore` on the same machine.
//!
//! One document of 20,000 single-clock rows from one actor (64-byte patches):
//! in-order appends of one row, a full read after reopening the database, and
//! a read of the last ten rows. Then 2,000 documents of 50 rows: the first
//! append and the first full read of documents the store has not touched since
//! it was reopened. `ROWS` and `DOCUMENTS` change the sizes.
use pulsify_protocol::{PatchRow, PatchStore};
use pulsify_rocksdb::{RocksOptions, RocksStore};
use pulsify_sqlite::SqliteStore;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const A: u64 = 65536;

fn row(doc_id: &str, clock: u64) -> PatchRow {
    // Different in every document and at every clock.
    let mut state = doc_id.bytes().fold(clock, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01B3)
    }) | 1;
    PatchRow {
        doc_id: doc_id.to_owned(),
        sid: A,
        clock,
        span: 1,
        dependencies: if clock == 1 { vec![] } else { vec![(A, clock)] },
        // 24 bytes that every patch repeats, as operation headers do, then noise.
        operations: (0..64u8)
            .map(|i| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                if i < 24 {
                    i * 7
                } else {
                    state as u8
                }
            })
            .collect(),
    }
}
fn ok<T, E: Into<pulsify_protocol::Error>>(result: Result<T, E>) -> T {
    result.map_err(Into::into).expect("store")
}
fn seed<S: PatchStore>(store: &mut S, doc_id: &str, rows: u64) {
    for start in (1..=rows).step_by(1000) {
        let batch: Vec<_> = (start..(start + 1000).min(rows + 1))
            .map(|clock| row(doc_id, clock))
            .collect();
        ok(store.append(&batch));
    }
}
fn timed<T>(work: impl FnOnce() -> T) -> (Duration, T) {
    let start = Instant::now();
    let value = work();
    (start.elapsed(), value)
}
fn median(mut times: Vec<Duration>) -> Duration {
    times.sort();
    times[times.len() / 2]
}
fn micros(time: Duration) -> String {
    format!("{:.1} µs", time.as_secs_f64() * 1e6)
}
fn millis(time: Duration) -> String {
    format!("{:.2} ms", time.as_secs_f64() * 1e3)
}
fn size(path: &Path) -> u64 {
    let Ok(metadata) = std::fs::metadata(path) else {
        return 0;
    };
    if !metadata.is_dir() {
        return metadata.len();
    }
    std::fs::read_dir(path)
        .map(|entries| entries.flatten().map(|entry| size(&entry.path())).sum())
        .unwrap_or(0)
}

/// `open` gives the store; `settle` finishes deferred work before it is closed.
fn run<S: PatchStore>(
    name: &str,
    appends: u64,
    path: Option<&Path>,
    open: &dyn Fn() -> S,
    settle: &dyn Fn(&S),
) {
    let rows: u64 = variable("ROWS", 20_000);
    let documents: u64 = variable("DOCUMENTS", 2_000);
    let mut store = open();
    let (seeding, ()) = timed(|| seed(&mut store, "doc", rows));
    let append = median(
        (1..=appends)
            .map(|i| {
                let next = row("doc", rows + i);
                timed(|| ok(store.append(std::slice::from_ref(&next)))).0
            })
            .collect(),
    );
    let tip = rows + appends + 1;
    let near = median(
        (0..2000)
            .map(|_| {
                let (time, found) = timed(|| ok(store.missing("doc", &vec![(A, tip - 10)])));
                assert_eq!(found.len(), 10);
                time
            })
            .collect(),
    );
    let warm = median(
        (0..9)
            .map(|_| timed(|| ok(store.missing("doc", &vec![]))).0)
            .collect(),
    );
    let mut line = format!(
        "{name:<26} seed {:>9}  append {:>10}  tip {:>8}  full warm {:>8}",
        millis(seeding),
        micros(append),
        micros(near),
        millis(warm),
    );
    // In memory, there is nothing to reopen.
    if let Some(path) = path {
        for document in 0..documents {
            let doc_id = format!("many-{document}");
            let batch: Vec<_> = (1..=50).map(|clock| row(&doc_id, clock)).collect();
            ok(store.append(&batch));
        }
        settle(&store);
        drop(store);
        let (opening, mut store) = timed(open);
        let (cold, found) = timed(|| ok(store.missing("doc", &vec![])));
        assert_eq!(found.len() as u64, tip - 1);
        // Documents spread over the key space, each touched for the first time.
        let step = (documents / 400).max(1);
        let first_read = median(
            (0..documents)
                .step_by(step as usize)
                .map(|document| {
                    let doc_id = format!("many-{document}");
                    let (time, found) = timed(|| ok(store.missing(&doc_id, &vec![])));
                    assert_eq!(found.len(), 50);
                    time
                })
                .collect(),
        );
        let first_append = median(
            (1..documents)
                .step_by(step as usize)
                .map(|document| {
                    let next = row(&format!("many-{document}"), 51);
                    timed(|| ok(store.append(std::slice::from_ref(&next)))).0
                })
                .collect(),
        );
        settle(&store);
        drop(store);
        line += &format!(
            "  open {:>8}  full cold {:>8}  | {documents} docs: first read {:>8}  first append {:>10}  | {:.1} MiB",
            millis(opening),
            millis(cold),
            micros(first_read),
            micros(first_append),
            size(path) as f64 / (1 << 20) as f64,
        );
    }
    println!("{line}");
}
fn variable(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn main() {
    let directory: PathBuf =
        std::env::temp_dir().join(format!("pulsify-store-bench-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).unwrap();
    let only = std::env::var("ONLY").unwrap_or_default();
    let wanted = |name: &str| name.contains(&only);

    for (name, appends, pragma) in [
        ("sqlite synchronous=FULL", 300, "PRAGMA synchronous=FULL"),
        ("sqlite synchronous=OFF", 5000, "PRAGMA synchronous=OFF"),
    ] {
        let path = directory.join(name.replace(['=', ' '], "-"));
        let open = || {
            let store = SqliteStore::open(&path).unwrap();
            store.connection().execute_batch(pragma).unwrap();
            store
        };
        let settle = |store: &SqliteStore| {
            let checkpoint = "PRAGMA wal_checkpoint(TRUNCATE)";
            store.connection().execute_batch(checkpoint).unwrap();
        };
        if wanted(name) {
            run(name, appends, Some(&path), &open, &settle);
        }
    }
    for (name, appends, sync) in [
        ("rocksdb sync", 300, true),
        ("rocksdb no sync", 5000, false),
    ] {
        let path = directory.join(name.replace(' ', "-"));
        let options = RocksOptions {
            sync,
            ..RocksOptions::default()
        };
        let open = || RocksStore::open_with(&path, &options).unwrap();
        // Files, as a database that has been running for a while holds its rows.
        let settle = |store: &RocksStore| store.flush().unwrap();
        if wanted(name) {
            run(name, appends, Some(&path), &open, &settle);
        }
    }
    if wanted("sqlite in memory") {
        let open = || SqliteStore::open_in_memory().unwrap();
        run("sqlite in memory", 5000, None, &open, &|_| ());
    }
    if wanted("rocksdb in memory") {
        let open = || RocksStore::open_in_memory().unwrap();
        run("rocksdb in memory", 5000, None, &open, &|_| ());
    }
    std::fs::remove_dir_all(&directory).unwrap();
}
