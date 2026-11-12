mod contract;
mod model;
mod storage;
#[cfg(test)]
mod tests;

use anyhow::{ensure, Context, Result};
use clap::Parser;
use model::{Fixture, Prepared};
use pulsify_protocol::{PatchLog, PatchRow};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Barrier,
    },
    thread,
    time::Instant,
};
use storage::{Output, Session};

#[derive(Parser, Clone, Serialize)]
struct Args {
    #[arg(long)]
    backend: String,
    #[arg(long)]
    contract_only: bool,
    #[arg(long)]
    fixture: String,
    #[arg(long)]
    output: String,
    #[arg(long, default_value = "local")]
    environment: String,
    #[arg(long, default_value = "1,16,64")]
    concurrency: String,
    #[arg(long, default_value_t = 400)]
    requests: usize,
    #[arg(long, default_value_t = 8)]
    documents: usize,
    #[arg(long, default_value = "spread,hot")]
    topologies: String,
    #[arg(
        long,
        default_value = "write_full,read_full,write_patch,compact,read_delta,mixed"
    )]
    scenarios: String,
    #[arg(long, default_value = "burst,saturation")]
    modes: String,
    #[arg(long, default_value = "")]
    postgres_url: String,
    #[arg(long, default_value = "/tmp/pulsify-native.sqlite")]
    sqlite_path: String,
    #[arg(long, default_value = "jitter")]
    sqlite_busy: String,
    #[arg(long, default_value_t = 67108864)]
    sqlite_mmap_bytes: u64,
    /// strict: a commit is flushed to disk before it is acknowledged.
    /// relaxed: the engine may acknowledge first and flush shortly after.
    #[arg(long, default_value = "strict")]
    durability: String,
    /// Directory of an embedded engine (RocksDB, LMDB).
    #[arg(long, default_value = "/tmp/pulsify-native-data")]
    data_path: String,
    /// Address of a non-PostgreSQL server (Valkey, Dragonfly, ScyllaDB, ClickHouse).
    #[arg(long, default_value = "")]
    server_url: String,
    /// Keep every document after its cell instead of deleting it. The database
    /// then holds the whole campaign, and its final size means something.
    #[arg(long)]
    keep_data: bool,
    /// Block cache of the LSM engines (RocksDB, LevelDB), in MiB.
    #[arg(long, default_value_t = 1024)]
    cache_mib: usize,
    /// Leave the per-request events out of the report; summaries remain.
    #[arg(long)]
    no_events: bool,
}
type Connect = Arc<dyn Fn() -> Result<Box<dyn Session>> + Send + Sync>;
#[derive(Clone)]
struct Factory {
    args: Args,
    connect: Connect,
}
impl Factory {
    fn connect(&self) -> Result<Box<dyn Session>> {
        (self.connect)()
    }
}
/// Initialize the selected engine once; return how to open one client session
/// and the settings the engine reports for itself.
fn open(args: &Args) -> Result<(Connect, serde_json::Value)> {
    let relaxed = args.durability == "relaxed";
    ensure!(
        relaxed || args.durability == "strict",
        "unknown durability tier"
    );
    let args = args.clone();
    let cache = args.cache_mib << 20;
    Ok(match args.backend.as_str() {
        #[cfg(feature = "other-databases")]
        "postgres" | "alloydb" | "orioledb" | "pgrust-row" | "pgrust-columnar" => {
            use storage::pg::Pg;
            Pg::initialize_for(&args.postgres_url, &args.backend)?;
            let metadata =
                Pg::open_for(&args.postgres_url, &args.backend, relaxed)?.metadata(relaxed)?;
            let connect: Connect = Arc::new(move || {
                Ok(Box::new(Pg::open_for(
                    &args.postgres_url,
                    &args.backend,
                    relaxed,
                )?))
            });
            (connect, metadata)
        }
        "sqlite" => {
            use storage::sqlite::Sqlite;
            Sqlite::initialize(&args.sqlite_path)?;
            let session = move || {
                Sqlite::open_with(
                    &args.sqlite_path,
                    &args.sqlite_busy,
                    args.sqlite_mmap_bytes,
                    relaxed,
                )
                .map(|session| (session, args.sqlite_busy.clone()))
            };
            let (first, busy) = session()?;
            let metadata = first.metadata(&busy, relaxed)?;
            (Arc::new(move || Ok(Box::new(session()?.0))), metadata)
        }
        "rocksdb" => {
            let db = storage::rocks::open(&args.data_path, cache)?;
            let metadata = storage::rocks::metadata("RocksDB TransactionDB", cache, !relaxed);
            let connect: Connect =
                Arc::new(move || Ok(Box::new(storage::rocks::Rocks(db.clone(), !relaxed))));
            (connect, metadata)
        }
        "rocksdb-mutex" => {
            let db = storage::rocks::open_plain(&args.data_path, cache)?;
            let metadata =
                storage::rocks::metadata("RocksDB DB (no TransactionDB)", cache, !relaxed);
            let connect: Connect =
                Arc::new(move || Ok(Box::new(storage::rocks::RocksMutex(db.clone(), !relaxed))));
            (connect, metadata)
        }
        #[cfg(feature = "other-databases")]
        "leveldb" => {
            let db = storage::leveldb::open(&args.data_path, cache)?;
            let metadata = serde_json::json!({"engine":"LevelDB 1.22 (leveldb-sys 2.0.9)","syncOnCommit":!relaxed,"writeBufferBytes":storage::leveldb::WRITE_BUFFER_BYTES,"blockCacheBytes":cache,"maxOpenFiles":storage::leveldb::MAX_OPEN_FILES,"compression":"Snappy","documentLock":"striped mutex in the runner: LevelDB has no lock manager"});
            let connect: Connect =
                Arc::new(move || Ok(Box::new(storage::leveldb::LevelDb(db.clone(), !relaxed))));
            (connect, metadata)
        }
        "lmdb" => {
            let lmdb = storage::lmdb::open(&args.data_path, relaxed)?;
            let metadata = serde_json::json!({"engine":"LMDB","noSync":relaxed,"mapSizeBytes":storage::lmdb::MAP_BYTES,"maxReaders":512});
            (Arc::new(move || Ok(Box::new(lmdb.clone()))), metadata)
        }
        #[cfg(feature = "other-databases")]
        "valkey" | "dragonfly" => {
            use storage::resp::Resp;
            let metadata = Resp::open(&args.server_url)?.metadata(&args.backend, relaxed)?;
            let connect: Connect = Arc::new(move || Ok(Box::new(Resp::open(&args.server_url)?)));
            (connect, metadata)
        }
        #[cfg(feature = "other-databases")]
        "scylla" => {
            use storage::scylla::Scylla;
            Scylla::initialize(&args.server_url)?;
            let metadata = Scylla::open(&args.server_url)?.metadata(relaxed)?;
            let connect: Connect = Arc::new(move || Ok(Box::new(Scylla::open(&args.server_url)?)));
            (connect, metadata)
        }
        #[cfg(feature = "other-databases")]
        "clickhouse" => {
            use storage::clickhouse::ClickHouse;
            ClickHouse::initialize(&args.server_url, relaxed)?;
            let metadata = ClickHouse::open(&args.server_url).metadata(relaxed)?;
            let connect: Connect =
                Arc::new(move || Ok(Box::new(ClickHouse::open(&args.server_url))));
            (connect, metadata)
        }
        _ => anyhow::bail!("unknown backend"),
    })
}
const OPERATIONS: [&str; 5] = [
    "write_full",
    "read_full",
    "write_patch",
    "compact",
    "read_delta",
];
#[derive(Clone)]
struct Job {
    operation: String,
    doc: String,
}
#[derive(Serialize, Clone)]
struct Event {
    operation: String,
    worker: usize,
    job: usize,
    service_ms: f64,
    queue_ms: f64,
    latency_ms: f64,
    completed_ms: f64,
    retries: u64,
    removed_segments: usize,
    rows: usize,
    bytes: usize,
    error: Option<String>,
}
#[derive(Serialize)]
struct Distribution {
    p50_ms: f64,
    p95_ms: f64,
    p99_ms: f64,
    max_ms: f64,
}
fn distribution(mut values: Vec<f64>) -> Distribution {
    if values.is_empty() {
        return Distribution {
            p50_ms: 0.,
            p95_ms: 0.,
            p99_ms: 0.,
            max_ms: 0.,
        };
    }
    values.sort_by(f64::total_cmp);
    let q = |p: f64| values[(values.len() as f64 * p).ceil().max(1.) as usize - 1];
    Distribution {
        p50_ms: q(0.5),
        p95_ms: q(0.95),
        p99_ms: q(0.99),
        max_ms: *values.last().unwrap(),
    }
}
#[derive(Serialize)]
struct Summary {
    requests: usize,
    success: usize,
    errors: usize,
    throughput_per_sec: f64,
    service: Distribution,
    queue: Distribution,
    latency: Distribution,
    retries: u64,
    useful_compactions: usize,
    noop_compactions: usize,
    removed_segments: usize,
    useful_compactions_per_sec: f64,
}
fn summarize(events: &[Event], seconds: f64) -> Summary {
    let success = events.iter().filter(|e| e.error.is_none()).count();
    let useful = events
        .iter()
        .filter(|e| e.operation == "compact" && e.removed_segments > 0 && e.error.is_none())
        .count();
    Summary {
        requests: events.len(),
        success,
        errors: events.len() - success,
        throughput_per_sec: success as f64 / seconds,
        service: distribution(events.iter().map(|e| e.service_ms).collect()),
        queue: distribution(events.iter().map(|e| e.queue_ms).collect()),
        latency: distribution(events.iter().map(|e| e.latency_ms).collect()),
        retries: events.iter().map(|e| e.retries).sum(),
        useful_compactions: useful,
        noop_compactions: events
            .iter()
            .filter(|e| e.operation == "compact" && e.removed_segments == 0 && e.error.is_none())
            .count(),
        removed_segments: events.iter().map(|e| e.removed_segments).sum(),
        useful_compactions_per_sec: useful as f64 / seconds,
    }
}
#[derive(Serialize)]
struct Cell {
    scenario: String,
    mode: String,
    topology: String,
    concurrency: usize,
    documents: usize,
    seconds: f64,
    maximum_active: usize,
    /// What the cell's documents hold once it ends, read back during verification.
    stored_segments: usize,
    stored_payload_bytes: usize,
    summary: Summary,
    operations: BTreeMap<String, Summary>,
    events: Vec<Event>,
    verification: Vec<Verification>,
}
#[derive(Serialize)]
struct Verification {
    doc: String,
    exact_rows: usize,
    segments: usize,
    payload_bytes: usize,
    frames: Vec<String>,
}
#[derive(Serialize)]
struct Report {
    format: u32,
    arguments: Args,
    metadata: serde_json::Value,
    cells: Vec<Cell>,
}

fn schedule(
    scenario: &str,
    count: usize,
    prefix: &str,
    topology: &str,
    documents: usize,
) -> Vec<Job> {
    let mut ops: Vec<&str> = if scenario == "mixed" {
        // Exact 20-request cycle: 9 patches, 5 vector reads, 2 of each other task.
        let cycle = [
            "write_patch",
            "read_delta",
            "write_full",
            "write_patch",
            "read_full",
            "write_patch",
            "read_delta",
            "compact",
            "write_patch",
            "read_delta",
            "write_patch",
            "write_full",
            "write_patch",
            "read_delta",
            "read_full",
            "write_patch",
            "compact",
            "write_patch",
            "read_delta",
            "write_patch",
        ];
        (0..count).map(|i| cycle[i % 20]).collect()
    } else {
        vec![scenario; count]
    };
    // Deterministically shuffle each cell; avoid a periodic pattern tied to worker count.
    let mut seed = 20261104u64;
    for i in (1..ops.len()).rev() {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        ops.swap(i, (seed as usize) % (i + 1));
    }
    ops.into_iter()
        .enumerate()
        .map(|(i, op)| {
            let doc = if op == "write_full" {
                format!("{prefix}/new/{i:08}")
            } else if scenario == "compact" && topology == "spread" {
                format!("{prefix}/compact/{i:08}")
            } else {
                format!(
                    "{prefix}/seed/{:08}",
                    if topology == "hot" { 0 } else { i % documents }
                )
            };
            Job {
                operation: op.into(),
                doc,
            }
        })
        .collect()
}

fn verify(
    session: &mut dyn Session,
    doc: &str,
    prepared: &Prepared,
    expected: Option<&[PatchRow]>,
    frames: bool,
) -> Result<Verification> {
    let (output, rows) = storage::read(session, doc, &vec![])?;
    let mut log = PatchLog::new(&prepared.seed_rows[0].doc_id);
    log.append(&rows)?;
    ensure!(
        log.pending_count() == 0,
        "pending causal history after load"
    );
    ensure!(
        log.vector() == output.vector,
        "stored frontier differs from exact history"
    );
    if let Some(expected) = expected {
        let key = |r: &PatchRow| (r.sid, r.clock);
        let mut actual = rows.clone();
        let mut wanted = expected.to_vec();
        actual.sort_by_key(key);
        wanted.sort_by_key(key);
        ensure!(actual == wanted, "lost, extra or changed history in {doc}");
    }
    // All rows are verified in Rust. Export representative histories for real TS materialization.
    let encoded = if frames {
        rows.chunks(1024)
            .map(|c| model::frame(c.to_vec()))
            .collect::<Result<Vec<_>>>()?
    } else {
        vec![]
    };
    Ok(Verification {
        doc: doc.into(),
        exact_rows: rows.len(),
        segments: output.segments.len(),
        payload_bytes: output.segments.iter().map(|s| s.payload.len()).sum(),
        frames: encoded,
    })
}

fn run_cell(
    factory: &Factory,
    p: &Arc<Prepared>,
    concurrency: usize,
    scenario: &str,
    topology: &str,
    mode: &str,
    prefix: &str,
) -> Result<Cell> {
    let jobs = Arc::new(schedule(
        scenario,
        factory.args.requests,
        prefix,
        topology,
        factory.args.documents,
    ));
    let mut setup = factory.connect()?;
    let mut seeded: BTreeMap<String, Vec<PatchRow>> = BTreeMap::new();
    for job in jobs.iter().filter(|j| j.operation != "write_full") {
        if seeded.contains_key(&job.doc) {
            continue;
        }
        // Standalone compaction gets a fresh, small closed history on every spread request.
        let seed = if scenario == "compact" {
            &p.seed[..p.seed.len().min(33)]
        } else {
            &p.seed
        };
        storage::append(&mut *setup, &job.doc, seed)?;
        seeded.insert(
            job.doc.clone(),
            seed.iter()
                .map(model::Segment::unpack)
                .collect::<Result<Vec<_>>>()?
                .into_iter()
                .flatten()
                .collect(),
        );
    }
    setup.settle(prefix)?;
    let barrier = Arc::new(Barrier::new(concurrency + 1));
    let next = Arc::new(AtomicUsize::new(0));
    let active = Arc::new(AtomicUsize::new(0));
    let maximum = Arc::new(AtomicUsize::new(0));
    let epoch = Arc::new(std::sync::OnceLock::<Instant>::new());
    let mut handles = Vec::new();
    for worker in 0..concurrency {
        let mut session = factory.connect()?;
        // Establish real connections and prepare client paths before releasing the barrier.
        session.transact("readiness", false, &mut |tx| {
            Ok(Output {
                vector: tx.vector()?,
                ..Default::default()
            })
        })?;
        let (p, jobs, barrier, next, active, maximum, epoch) = (
            p.clone(),
            jobs.clone(),
            barrier.clone(),
            next.clone(),
            active.clone(),
            maximum.clone(),
            epoch.clone(),
        );
        let mode = mode.to_owned();
        handles.push(thread::spawn(
            move || -> Result<(Vec<Event>, Vec<(String, model::Segment)>)> {
                barrier.wait();
                let origin = *epoch.get().unwrap();
                let mut events = Vec::new();
                let mut writes = Vec::new();
                let mut sent: HashMap<String, usize> = HashMap::new();
                let mut stream = 0;
                loop {
                    let id = next.fetch_add(1, Ordering::SeqCst);
                    if id >= jobs.len() {
                        break;
                    }
                    let job = &jobs[id];
                    let service_start = Instant::now();
                    let queued = if mode == "burst" {
                        service_start.duration_since(origin).as_secs_f64() * 1000.
                    } else {
                        0.
                    };
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    maximum.fetch_max(now, Ordering::SeqCst);
                    let mut output = Output::default();
                    let mut row_count = 0;
                    let mut byte_count = 0;
                    let result = (|| -> Result<()> {
                        match job.operation.as_str() {
                            "write_full" => {
                                output = storage::append(&mut *session, &job.doc, &p.initial)?;
                            }
                            "write_patch" => {
                                p.streams[worker]
                                    .get(stream)
                                    .context("fixture stream exhausted")?;
                                // Each worker has its own actor stream per document; avoid causal gaps
                                // when a worker alternates documents under the spread workload.
                                if !sent.contains_key(&job.doc) {
                                    sent.insert(job.doc.clone(), 0);
                                }
                                let prior = sent.get_mut(&job.doc).unwrap();
                                let segment = &p.streams[worker][*prior];
                                output = storage::append(
                                    &mut *session,
                                    &job.doc,
                                    std::slice::from_ref(segment),
                                )?;
                                writes.push((job.doc.clone(), segment.clone()));
                                *prior += 1;
                                stream += 1;
                            }
                            "read_full" | "read_delta" => {
                                let remote = if job.operation == "read_delta" {
                                    &p.remote
                                } else {
                                    &vec![]
                                };
                                let (read, rows) = storage::read(&mut *session, &job.doc, remote)?;
                                row_count = rows.len();
                                byte_count = read.segments.iter().map(|s| s.payload.len()).sum();
                                output = read;
                            }
                            "compact" => {
                                output = storage::compact(&mut *session, &job.doc)?;
                            }
                            _ => anyhow::bail!("unknown operation"),
                        }
                        Ok(())
                    })();
                    active.fetch_sub(1, Ordering::SeqCst);
                    let service = service_start.elapsed().as_secs_f64() * 1000.;
                    events.push(Event {
                        operation: job.operation.clone(),
                        worker,
                        job: id,
                        service_ms: service,
                        queue_ms: queued,
                        latency_ms: service + queued,
                        completed_ms: origin.elapsed().as_secs_f64() * 1000.,
                        retries: output.retries,
                        removed_segments: output.removed,
                        rows: row_count,
                        bytes: byte_count,
                        error: result.err().map(|e| format!("{e:#}")),
                    });
                }
                Ok((events, writes))
            },
        ));
    }
    epoch.set(Instant::now()).unwrap();
    barrier.wait();
    let mut events = Vec::new();
    for handle in handles {
        let (mut observed, writes) = handle
            .join()
            .map_err(|_| anyhow::anyhow!("worker panicked"))??;
        events.append(&mut observed);
        for (doc, segment) in writes {
            seeded.get_mut(&doc).unwrap().extend(segment.unpack()?);
        }
    }
    let seconds = events.iter().map(|e| e.completed_ms).fold(0.0, f64::max) / 1000.;
    // Verification is intentionally after timing and checks every accepted append exactly.
    let mut verification = Vec::new();
    for (i, (doc, expected)) in seeded.iter().enumerate() {
        verification.push(verify(&mut *setup, doc, p, Some(expected), i < 2)?);
    }
    for job in jobs.iter().filter(|j| j.operation == "write_full") {
        let expected = p
            .initial
            .iter()
            .map(model::Segment::unpack)
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        let result = verify(
            &mut *setup,
            &job.doc,
            p,
            Some(&expected),
            verification.len() < 2,
        );
        if let Ok(v) = result {
            verification.push(v);
        } else if !events.iter().any(|e| {
            e.job == jobs.iter().position(|j| j.doc == job.doc).unwrap() && e.error.is_some()
        }) {
            result?;
        }
    }
    let operations = OPERATIONS
        .iter()
        .filter_map(|op| {
            let selected = events
                .iter()
                .filter(|e| e.operation == *op)
                .cloned()
                .collect::<Vec<_>>();
            (!selected.is_empty()).then(|| (op.to_string(), summarize(&selected, seconds)))
        })
        .collect();
    if !factory.args.keep_data {
        setup.cleanup(prefix)?;
    }
    setup.settle(prefix)?;
    let summary = summarize(&events, seconds);
    eprintln!("{}/{scenario}/{topology}/{mode}/c{concurrency}: {:.1} req/s, p99 {:.2} ms, {} errors, {} retries, {}/{} useful/noop compactions",factory.args.backend,summary.throughput_per_sec,summary.service.p99_ms,summary.errors,summary.retries,summary.useful_compactions,summary.noop_compactions);
    Ok(Cell {
        scenario: scenario.into(),
        mode: mode.into(),
        topology: topology.into(),
        concurrency,
        documents: seeded.len(),
        seconds,
        maximum_active: maximum.load(Ordering::SeqCst),
        stored_segments: verification.iter().map(|v| v.segments).sum(),
        stored_payload_bytes: verification.iter().map(|v| v.payload_bytes).sum(),
        summary,
        operations,
        events: if factory.args.no_events {
            vec![]
        } else {
            events
        },
        verification,
    })
}
fn main() -> Result<()> {
    let args = Args::parse();
    ensure!(
        args.requests > 0 && args.requests % 20 == 0,
        "requests must be a positive multiple of 20 for exact mixture"
    );
    ensure!(args.documents > 0, "documents must be positive");
    let p = Arc::new(Prepared::new(serde_json::from_slice::<Fixture>(
        &fs::read(&args.fixture)?,
    )?)?);
    let concurrency = args
        .concurrency
        .split(',')
        .map(str::parse)
        .collect::<std::result::Result<Vec<usize>, _>>()?;
    ensure!(
        concurrency.iter().all(|c| *c > 0 && *c <= p.streams.len()),
        "concurrency exceeds actual fixture actor streams"
    );
    let (connect, database_metadata) = open(&args)?;
    let factory = Factory {
        args: args.clone(),
        connect,
    };
    contract::verify(|| factory.connect().expect("contract connection"));
    if args.contract_only {
        fs::write(&args.output, serde_json::to_vec_pretty(&database_metadata)?)?;
        return Ok(());
    }
    let mut report = Report {
        format: 2,
        arguments: args.clone(),
        metadata: serde_json::json!({"database":database_metadata,"profile":p.profile,"durability":args.durability,"platform":std::env::consts::OS,"cpus":thread::available_parallelism().map_or(0, |n| n.get()),"architecture":std::env::consts::ARCH,"benchmarkVersion":env!("CARGO_PKG_VERSION"),"sqliteVersion":rusqlite::version(),"commit":std::env::var("BENCH_COMMIT").unwrap_or_default()}),
        cells: Vec::new(),
    };
    let run = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    for c in concurrency {
        for scenario in args.scenarios.split(',') {
            for topology in args.topologies.split(',') {
                for mode in args.modes.split(',') {
                    ensure!(
                        OPERATIONS.contains(&scenario) || scenario == "mixed",
                        "unknown scenario"
                    );
                    ensure!(
                        ["spread", "hot"].contains(&topology)
                            && ["burst", "saturation"].contains(&mode),
                        "unknown topology/mode"
                    );
                    let prefix =
                        format!("r{run}/{}/{c}/{scenario}/{topology}/{mode}", args.backend);
                    report.cells.push(run_cell(
                        &factory, &p, c, scenario, topology, mode, &prefix,
                    )?);
                    fs::write(&args.output, serde_json::to_vec(&report)?)?; // checkpoint completed cells
                }
            }
        }
    }
    let errors: usize = report.cells.iter().map(|c| c.summary.errors).sum();
    drop(factory);
    ensure!(
        errors == 0,
        "campaign completed with {errors} request errors (retained in report)"
    );
    Ok(())
}
