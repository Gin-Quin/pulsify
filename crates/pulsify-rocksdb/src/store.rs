use crate::{Error, Result};
use pulsify_protocol::{covers_document, document_prefixes, DocumentStore};
use pulsify_protocol::{
    is_gap, last_register_of, validate_rows, validate_vector, AppendResult, PatchRow, PatchStore,
    VersionVector, GAP_OPERATIONS, MAX_SAFE_INTEGER, MAX_VECTOR_ENTRIES,
};
use rocksdb::{
    BlockBasedOptions, Cache, ColumnFamily, ColumnFamilyDescriptor, DBCompressionType,
    DBRawIterator, Env, LogLevel, Options, ReadOptions, SliceTransform, WriteBatch, WriteOptions,
    DB,
};
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

// Column families. Every key starts with the document ID and a NUL, which an
// ID cannot contain, so a document is one contiguous key range in each of
// them; integers are big-endian, so keys sort by `(doc_id, sid, clock)`.
/// `doc_id NUL sid clock` to a history row or a packed run of rows.
const ROWS: &str = "rows";
/// `doc_id NUL sid` to the actor's committed clock.
const CLOCKS: &str = "clocks";
/// `doc_id NUL sid clock` to the span and dependencies of a row that is not
/// ready yet: what promotion needs, without reading the rows.
const PENDING: &str = "pending";
/// `doc_id NUL sid register` to an actor's newest write to a register without
/// history, overwritten in place: its clock (big-endian), then the row as
/// `rows` encodes it. The register is the encoded target and field of the
/// write, as bytes.
const VALUES: &str = "values";
const TOMBSTONES: &str = "tombstones";
const FAMILIES: [&str; 5] = [ROWS, CLOCKS, PENDING, VALUES, TOMBSTONES];
/// The register index of an unreleased layout: moved to `values` and dropped
/// when the database is opened.
const REGISTERS: &str = "registers";
/// Empty column family. Older stores refuse to open it, even if they would
/// not encounter a packed row on an in-order append.
const PACKED_LAYOUT: &str = "packed_layout";
const FORMAT_ROW: u8 = 0;
const FORMAT_PACKED: u8 = 1;
/// Values from this size live in blob files (as in the storage benchmark).
const MIN_BLOB_BYTES: u64 = 4096;
const MIN_PACKED_ROWS: usize = 8;
const MAX_PACKED_ROWS: usize = 64;
const MAX_PACKED_BYTES: usize = 4095;

/// How a [`RocksStore`] is opened. `RocksOptions::default()` is durable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RocksOptions {
    /// Sync the write-ahead log before `append` returns, like SQLite's
    /// `synchronous=FULL`. Without it, a power loss or system crash can lose
    /// the last appends (never corrupt or half-apply one); a process crash
    /// loses nothing.
    pub sync: bool,
    /// Memory for the cache of uncompressed blocks, shared by the column
    /// families. Index and filter blocks are charged to it too.
    pub block_cache_bytes: usize,
    /// Size of the in-memory buffer of rows before it is flushed to a file.
    pub write_buffer_bytes: usize,
    /// How many documents keep their vector and pending rows in memory. An
    /// append to one of them reads nothing from the database. 0 disables it.
    pub cached_documents: usize,
}
impl Default for RocksOptions {
    fn default() -> Self {
        Self {
            sync: true,
            block_cache_bytes: 32 << 20,
            write_buffer_bytes: 16 << 20,
            cached_documents: 1024,
        }
    }
}

/// The key prefix shared by everything of one document: the ID and its NUL.
fn document_prefix(key: &[u8]) -> &[u8] {
    match key.iter().position(|byte| *byte == 0) {
        Some(end) => &key[..=end],
        None => key,
    }
}

fn database_options() -> Options {
    let mut options = Options::default();
    options.create_if_missing(true);
    options.create_missing_column_families(true);
    // Hand file data to the OS as it is written instead of in one burst when a
    // flush or compaction ends, which would stall a synced append behind it.
    options.set_bytes_per_sync(1 << 20);
    // One writer (`append` takes `&mut self`): nothing to gain from the
    // concurrent memtable insert path.
    options.set_allow_concurrent_memtable_write(false);
    // The info log is not needed: keep warnings, two files at most, and no
    // periodic statistics dump or its background thread.
    options.set_log_level(LogLevel::Warn);
    options.set_keep_log_file_num(2);
    options.set_stats_dump_period_sec(0);
    options.set_stats_persist_period_sec(0);
    options
}

fn family_options(cache: &Cache, rows: Option<&RocksOptions>) -> Options {
    let mut options = Options::default();
    // Every read is a seek or a scan inside one document, never a point
    // lookup: files and blocks are filtered by document prefix rather than by
    // whole key, so a seek skips the files that do not hold the document.
    options.set_prefix_extractor(SliceTransform::create(
        "pulsify.document",
        document_prefix,
        None,
    ));
    let mut table = BlockBasedOptions::default();
    table.set_block_cache(cache);
    table.set_bloom_filter(10.0, false);
    table.set_whole_key_filtering(false);
    // Bound memory by the block cache, indexes and filters included, keeping
    // those of the newest files, which every read consults, always loaded.
    table.set_cache_index_and_filter_blocks(true);
    table.set_pin_l0_filter_and_index_blocks_in_cache(true);
    match rows {
        Some(store) => {
            options.set_write_buffer_size(store.write_buffer_bytes);
            // Rows are read in runs of consecutive keys: larger blocks compress
            // better and cost fewer reads per scan.
            table.set_block_size(16 << 10);
            // Cheap LZ4 where data is rewritten often, ZSTD where it settles.
            options.set_compression_type(DBCompressionType::Lz4);
            options.set_bottommost_compression_type(DBCompressionType::Zstd);
            // A large patch is written once to a blob file instead of being
            // rewritten at each level. A value is overwritten by its actor's
            // next write to the register: compactions collect what it leaves
            // in the oldest blob files.
            options.set_enable_blob_files(true);
            options.set_min_blob_size(MIN_BLOB_BYTES);
            options.set_blob_compression_type(DBCompressionType::Lz4);
            options.set_enable_blob_gc(true);
        }
        None => {
            // Clocks are overwritten by every append and pending
            // entries are short-lived: a small buffer drops the obsolete
            // versions when it is flushed, and the files stay tiny.
            options.set_write_buffer_size(2 << 20);
            options.set_compression_type(DBCompressionType::Lz4);
        }
    }
    options.set_block_based_table_factory(&table);
    options
}

/// A row that waits for its predecessors or its dependencies.
struct Pending {
    sid: u64,
    start: u64,
    end: u64,
    dependencies: VersionVector,
    /// Whether the `pending` column family holds it.
    stored: bool,
}

/// What an append needs to know of a document besides the rows it touches.
#[derive(Default)]
struct Document {
    frontier: BTreeMap<u64, u64>,
    pending: Vec<Pending>,
    used: u64,
}

/// Rows keyed by `(doc_id, sid, clock)`, whose operations are immutable. Rows
/// stay pending until their actor prefix is contiguous and their dependencies
/// are stored. A field without history keeps each actor's newest write to it
/// in `values`, overwritten in place: the sequence numbers of the writes it
/// replaces hold nothing, and spans are computed when rows are read.
///
/// A store owns its database: RocksDB locks the directory, so no other
/// process (or second `RocksStore`) can open it. Writes go through `&mut
/// self`, one at a time, each as one atomic write batch; reads take `&self`
/// and can run from several threads between writes. Wrap the store in a
/// `Mutex` (or use a [`Hub`](crate::Hub)) to share it.
pub struct RocksStore {
    db: DB,
    sync: bool,
    pack_appends: bool,
    /// Vectors and pending rows of recently used documents. Only this store
    /// writes to the database, so they cannot go stale.
    documents: HashMap<String, Document>,
    capacity: usize,
    tick: u64,
}

impl RocksStore {
    /// Opens or creates a durable database directory with the default options.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_with(path, &RocksOptions::default())
    }
    pub fn open_with(path: impl AsRef<Path>, options: &RocksOptions) -> Result<Self> {
        Self::create(database_options(), path.as_ref(), options)
    }
    /// A database that lives in memory and disappears with the store.
    pub fn open_in_memory() -> Result<Self> {
        let mut database = database_options();
        database.set_env(&Env::mem_env()?);
        let options = RocksOptions {
            sync: false,
            ..RocksOptions::default()
        };
        // The files live in the memory environment. Only the (empty)
        // directory is created on disk, by the `rocksdb` crate when it opens;
        // in-memory stores share it without seeing each other.
        let path = std::env::temp_dir().join("pulsify-rocksdb-in-memory");
        Self::create(database, &path, &options)
    }
    fn create(database: Options, path: &Path, options: &RocksOptions) -> Result<Self> {
        let cache = Cache::new_lru_cache(options.block_cache_bytes);
        // An unreleased layout kept a register index: it is opened to be moved.
        let existing = DB::list_cf(&database, path).unwrap_or_default();
        let registers = existing.iter().any(|name| name == REGISTERS);
        let mut families = vec![
            ColumnFamilyDescriptor::new(ROWS, family_options(&cache, Some(options))),
            ColumnFamilyDescriptor::new(CLOCKS, family_options(&cache, None)),
            ColumnFamilyDescriptor::new(PENDING, family_options(&cache, None)),
            ColumnFamilyDescriptor::new(VALUES, family_options(&cache, Some(options))),
            ColumnFamilyDescriptor::new(TOMBSTONES, family_options(&cache, None)),
        ];
        if registers {
            families.push(ColumnFamilyDescriptor::new(
                REGISTERS,
                family_options(&cache, None),
            ));
        }
        if existing.iter().any(|name| name == PACKED_LAYOUT) {
            families.push(ColumnFamilyDescriptor::new(
                PACKED_LAYOUT,
                Options::default(),
            ));
        }
        let mut store = Self {
            db: DB::open_cf_descriptors(&database, path, families)?,
            sync: options.sync,
            pack_appends: true,
            documents: HashMap::new(),
            capacity: options.cached_documents,
            tick: 0,
        };
        if registers {
            store.move_registers()?;
        }
        Ok(store)
    }
    /// Moves the rows the register index names to `values`, drops the ready
    /// gap rows (holes now: the clocks say how far each actor goes), then the
    /// index. Each step can be repeated if the process stops in between.
    fn move_registers(&mut self) -> Result<()> {
        let total = || {
            let mut options = ReadOptions::default();
            options.set_total_order_seek(true);
            options
        };
        let mut frontiers = HashMap::new();
        for entry in
            self.db
                .iterator_cf_opt(self.family(CLOCKS)?, total(), rocksdb::IteratorMode::Start)
        {
            let (key, value) = entry?;
            frontiers.insert(key.to_vec(), integer(&value).ok_or_else(corrupt)?);
        }
        let ready = |prefix: &[u8], sid: u64, clock: u64| {
            let mut key = prefix.to_vec();
            key.extend_from_slice(&sid.to_be_bytes());
            frontiers
                .get(&key)
                .is_some_and(|frontier| clock < *frontier)
        };
        let mut batch = WriteBatch::default();
        let (rows, values) = (self.family(ROWS)?, self.family(VALUES)?);
        for entry in self.db.iterator_cf_opt(
            self.family(REGISTERS)?,
            total(),
            rocksdb::IteratorMode::Start,
        ) {
            let (key, holder) = entry?;
            let prefix = document_prefix(&key);
            let register = &key[prefix.len()..];
            let field = |at: usize| holder.get(at..at + 8).and_then(integer).ok_or_else(corrupt);
            let (sid, clock) = (field(0)?, field(8)?);
            let key = row_key(prefix, sid, clock);
            if !ready(prefix, sid, clock) {
                continue;
            }
            if let Some(row) = self.db.get_cf(rows, &key)? {
                let row = Held::stored(clock, &row)?;
                batch.put_cf(values, value_key(prefix, sid, register), encode_value(&row));
                batch.delete_cf(rows, &key);
            }
        }
        for entry in self
            .db
            .iterator_cf_opt(rows, total(), rocksdb::IteratorMode::Start)
        {
            let (key, value) = entry?;
            let prefix = document_prefix(&key);
            let (sid, clock) = row_key_of(&key, prefix).ok_or_else(corrupt)?;
            if ready(prefix, sid, clock) && is_gap(header(&value)?.2) {
                batch.delete_cf(rows, &key);
            }
        }
        let mut options = WriteOptions::default();
        options.set_sync(true);
        self.db.write_opt(batch, &options)?;
        self.db.drop_cf(REGISTERS)?;
        Ok(())
    }
    /// The underlying database, to inspect or back up. Writing to it would
    /// break the store.
    pub fn db(&self) -> &DB {
        &self.db
    }
    /// Control packing of ready history rows for this open store. Packing is
    /// on by default. Disable it before the first packed append to keep the
    /// directory readable by older versions. Existing segments stay readable.
    pub fn set_pack_appends(&mut self, enabled: bool) {
        self.pack_appends = enabled;
    }
    /// Writes the in-memory buffers to files. Appends are durable without it.
    pub fn flush(&self) -> Result<()> {
        for name in FAMILIES {
            self.db.flush_cf(self.family(name)?)?;
        }
        Ok(())
    }

    /// Validates and stores rows of one document in one atomic write batch.
    /// Retransmissions are ignored; a conflict writes nothing.
    pub fn append(&mut self, rows: &[PatchRow]) -> Result<AppendResult> {
        let Some(doc_id) = validate_rows(rows)? else {
            return Ok(AppendResult::default());
        };
        self.assert_live(doc_id)?;
        let prefix = prefix_of(doc_id);
        let (name, mut document) = match self.documents.remove_entry(doc_id) {
            Some(entry) => entry,
            None => (doc_id.to_owned(), self.load(&prefix)?),
        };
        // A failure leaves the database as it was and forgets the document's
        // state, which this attempt modified: the next call reads it again.
        let result = self.append_rows(&prefix, &mut document, rows)?;
        self.remember(name, document);
        Ok(result)
    }

    pub fn vector(&self, doc_id: &str) -> Result<VersionVector> {
        validate_doc_id(doc_id)?;
        self.assert_live(doc_id)?;
        Ok(match self.documents.get(doc_id) {
            Some(document) => document.frontier.iter().map(|(k, v)| (*k, *v)).collect(),
            None => self
                .read_frontier(&prefix_of(doc_id))?
                .into_iter()
                .collect(),
        })
    }

    /// Ready rows the peer lacks, ordered by actor and clock.
    pub fn missing(&self, doc_id: &str, remote: &VersionVector) -> Result<Vec<PatchRow>> {
        validate_doc_id(doc_id)?;
        validate_vector(remote)?;
        self.assert_live(doc_id)?;
        let prefix = prefix_of(doc_id);
        match self.documents.get(doc_id) {
            Some(document) => self.read_missing(doc_id, &prefix, &document.frontier, remote),
            None => self.read_missing(doc_id, &prefix, &self.read_frontier(&prefix)?, remote),
        }
    }

    /// `missing` and `vector` of the same state: nothing writes in between.
    pub fn sync_state(
        &mut self,
        doc_id: &str,
        remote: &VersionVector,
    ) -> Result<(Vec<PatchRow>, VersionVector)> {
        validate_doc_id(doc_id)?;
        validate_vector(remote)?;
        self.assert_live(doc_id)?;
        let prefix = prefix_of(doc_id);
        // A peer that connects usually writes next: keep what was read.
        if !self.documents.contains_key(doc_id) {
            let document = self.load(&prefix)?;
            self.remember(doc_id.to_owned(), document);
        }
        let loaded;
        let frontier = match self.documents.get(doc_id) {
            Some(document) => &document.frontier,
            None => {
                loaded = self.read_frontier(&prefix)?;
                &loaded
            }
        };
        let rows = self.read_missing(doc_id, &prefix, frontier, remote)?;
        Ok((rows, frontier.iter().map(|(k, v)| (*k, *v)).collect()))
    }

    fn assert_live(&self, doc_id: &str) -> Result<()> {
        if self.is_deleted(doc_id)? {
            return Err(Error::new(
                "NOT_FOUND",
                format!("Document {doc_id} was permanently deleted"),
            ));
        }
        Ok(())
    }
    fn family(&self, name: &str) -> Result<&ColumnFamily> {
        self.db
            .cf_handle(name)
            .ok_or_else(|| Error::new("CONNECTION_FAILED", "Missing RocksDB column family"))
    }
    /// An iterator over one document of a column family.
    fn cursor(&self, family: &str, prefix: &[u8]) -> Result<DBRawIterator<'_>> {
        let mut options = ReadOptions::default();
        options.set_prefix_same_as_start(true);
        let mut end = prefix.to_vec();
        *end.last_mut().expect("the NUL") = 1;
        options.set_iterate_upper_bound(end);
        // Appends also step backwards: never into the document before this one.
        options.set_iterate_lower_bound(prefix.to_vec());
        Ok(self.db.raw_iterator_cf_opt(self.family(family)?, options))
    }
    fn remember(&mut self, name: String, mut document: Document) {
        if self.capacity == 0 {
            return;
        }
        if self.documents.len() >= self.capacity {
            let oldest = self.documents.iter().min_by_key(|entry| entry.1.used);
            if let Some(name) = oldest.map(|entry| entry.0.clone()) {
                self.documents.remove(&name);
            }
        }
        self.tick += 1;
        document.used = self.tick;
        self.documents.insert(name, document);
    }

    fn read_frontier(&self, prefix: &[u8]) -> Result<BTreeMap<u64, u64>> {
        let mut frontier = BTreeMap::new();
        let mut cursor = self.cursor(CLOCKS, prefix)?;
        cursor.seek(prefix);
        while let Some((key, value)) = cursor.item() {
            let sid = key.get(prefix.len()..).and_then(integer);
            frontier.insert(
                sid.ok_or_else(corrupt)?,
                integer(value).ok_or_else(corrupt)?,
            );
            cursor.next();
        }
        cursor.status()?;
        Ok(frontier)
    }
    fn load(&self, prefix: &[u8]) -> Result<Document> {
        let mut pending = Vec::new();
        let mut cursor = self.cursor(PENDING, prefix)?;
        cursor.seek(prefix);
        while let Some((key, value)) = cursor.item() {
            let (sid, start) = row_key_of(key, prefix).ok_or_else(corrupt)?;
            let (span, dependencies, _) = header(value)?;
            pending.push(Pending {
                sid,
                start,
                end: start + span,
                dependencies,
                stored: true,
            });
            cursor.next();
        }
        cursor.status()?;
        Ok(Document {
            frontier: self.read_frontier(prefix)?,
            pending,
            used: 0,
        })
    }

    /// The rule of `SqliteStore` and of the TypeScript `SqlitePatchStore`,
    /// step for step. A row is ready when it starts before its actor's clock.
    fn append_rows(
        &mut self,
        prefix: &[u8],
        document: &mut Document,
        rows: &[PatchRow],
    ) -> Result<AppendResult> {
        let Document {
            frontier, pending, ..
        } = document;
        let waiting = self.family(PENDING)?;
        let mut batch = WriteBatch::default();
        let mut view = View {
            store: self,
            prefix,
            cursor: None,
            rows: BTreeMap::new(),
            packed: None,
            values: BTreeMap::new(),
            actor_values: HashMap::new(),
        };
        // The waiting rows of an actor in `[from, to)` were replaced.
        fn remove_waiting(
            view: &mut View<'_, '_>,
            batch: &mut WriteBatch,
            waiting: &ColumnFamily,
            pending: &mut Vec<Pending>,
            (sid, from, to): (u64, u64, u64),
        ) {
            pending.retain(|each| {
                if each.sid != sid || each.start < from || each.start >= to {
                    return true;
                }
                view.remove(sid, each.start);
                if each.stored {
                    batch.delete_cf(waiting, row_key(view.prefix, sid, each.start));
                }
                false
            });
        }
        let mut pending_actors: BTreeSet<u64> = pending.iter().map(|row| row.sid).collect();
        let mut changed_actors = BTreeSet::new();
        let (mut inserted, mut ready) = (0, 0);
        for row in rows {
            let (sid, clock, end) = (row.sid, row.clock, row.clock + row.span);
            let reached = frontier.get(&sid).copied().unwrap_or(1);
            if clock < reached {
                // Known, or replaced here: only its contents can conflict, with
                // what is held at that clock, and only its span can say that
                // more writes were replaced.
                if let Some(held) = view.held_at(sid, clock)? {
                    if differ(&held, &row.operations) {
                        return Err(conflict("Conflicting storage segment"));
                    }
                }
                if end <= reached {
                    continue;
                }
                // Rows that waited below the new frontier were replaced.
                remove_waiting(&mut view, &mut batch, waiting, pending, (sid, reached, end));
                frontier.insert(sid, end);
                changed_actors.insert(sid);
                inserted += 1;
                continue;
            }
            // A row that is ready on arrival (the common, in-order case) never
            // enters the pending column family.
            let ready_now = clock == reached && covered(frontier, &row.dependencies);
            if ready_now && !pending_actors.contains(&sid) {
                // Ready rows of an actor start below the frontier and it has no
                // pending row, so no stored row starts at or after this one: it is
                // neither a duplicate nor overlapping. Only the fork check
                // remains, without reading anything.
                if clock > 1 && own_clock(&row.dependencies, sid) < clock {
                    return Err(conflict("Actor history fork"));
                }
            } else {
                if let Some(mut existing) = view.get(sid, clock)? {
                    // A waiting row with the same start: only contents conflict.
                    if differ(&existing.operations, &row.operations) {
                        return Err(conflict("Conflicting storage segment"));
                    }
                    // The longer span knows of more replaced writes, the waiting
                    // rows that start inside it among them.
                    if row.span > existing.span {
                        existing.span = row.span;
                        for each in pending.iter_mut() {
                            if each.sid == sid && each.start == clock {
                                each.end = end;
                                if each.stored {
                                    let mut value = Vec::new();
                                    encode_header(&mut value, row.span, &existing.dependencies);
                                    batch.put_cf(waiting, row_key(prefix, sid, clock), value);
                                }
                            }
                        }
                        view.update(sid, existing);
                        let covered = (sid, clock + 1, end);
                        remove_waiting(&mut view, &mut batch, waiting, pending, covered);
                    }
                    continue;
                }
                if let Some(before) = view.before(sid, clock)? {
                    let before_end = before.clock + before.span;
                    // It starts among the writes a waiting row has replaced.
                    if before_end > clock {
                        continue;
                    }
                    if own_clock(&row.dependencies, sid) < before_end {
                        return Err(conflict("Actor history fork"));
                    }
                }
                // The first row past its span builds on it, like the journal checks.
                if let Some(next) = view.after(sid, end - 1)? {
                    if own_clock(&next.dependencies, sid) < end {
                        return Err(conflict("Actor history fork"));
                    }
                }
                // Rows still waiting that this row has replaced.
                let covered = (sid, clock + 1, end);
                remove_waiting(&mut view, &mut batch, waiting, pending, covered);
            }
            let held = Held {
                clock,
                span: row.span,
                dependencies: row.dependencies.clone(),
                operations: Cow::Borrowed(&row.operations),
            };
            inserted += 1;
            if ready_now {
                if view.keep(sid, &held) {
                    view.insert(sid, held);
                }
                frontier.insert(sid, end);
                changed_actors.insert(sid);
                ready += 1;
            } else {
                view.insert(sid, held);
                pending.push(Pending {
                    sid,
                    start: clock,
                    end,
                    dependencies: row.dependencies.clone(),
                    stored: false,
                });
                pending_actors.insert(sid);
            }
        }
        let actors = frontier
            .keys()
            .chain(pending_actors.iter())
            .collect::<BTreeSet<_>>()
            .len();
        if actors > MAX_VECTOR_ENTRIES {
            return Err(Error::new(
                "LIMIT_EXCEEDED",
                "Document actor limit exceeded",
            ));
        }
        // A row is ready when it starts before its actor's clock, so promoting
        // a history row only moves the clock: the row itself is not rewritten.
        pending.sort_by_key(|row| (row.sid, row.start));
        loop {
            let mut promoted = Vec::new();
            pending.retain(|row| {
                let contiguous = row.start == frontier.get(&row.sid).copied().unwrap_or(1);
                if !contiguous || !covered(frontier, &row.dependencies) {
                    return true;
                }
                if row.stored {
                    batch.delete_cf(waiting, row_key(prefix, row.sid, row.start));
                }
                let clock = frontier.entry(row.sid).or_insert(0);
                *clock = (*clock).max(row.end);
                changed_actors.insert(row.sid);
                promoted.push((row.sid, row.start));
                false
            });
            if promoted.is_empty() {
                break;
            }
            ready += promoted.len();
            // A last-value row moves to its value, a gap row disappears: this
            // changes neither the clocks nor what waits, so it can follow the pass.
            for (sid, start) in promoted {
                if let Some(row) = view.get(sid, start)? {
                    if !view.keep(sid, &row) {
                        view.remove(sid, start);
                    }
                }
            }
        }
        for row in pending.iter_mut().filter(|row| !row.stored) {
            let mut value = Vec::new();
            encode_header(&mut value, row.end - row.start, &row.dependencies);
            batch.put_cf(waiting, row_key(prefix, row.sid, row.start), value);
            row.stored = true;
        }
        let packed = view.write(&mut batch, frontier)?;
        let clocks = self.family(CLOCKS)?;
        for sid in changed_actors {
            let mut key = prefix.to_vec();
            key.extend_from_slice(&sid.to_be_bytes());
            batch.put_cf(clocks, key, frontier[&sid].to_be_bytes());
        }
        // Install the compatibility marker before the first packed batch.
        // Opening an old directory or writing ordinary rows keeps its layout.
        if packed && self.db.cf_handle(PACKED_LAYOUT).is_none() {
            self.db.create_cf(PACKED_LAYOUT, &Options::default())?;
        }
        // Resends alone change nothing: no write, and no sync to wait for.
        if !batch.is_empty() {
            let mut options = WriteOptions::default();
            options.set_sync(self.sync);
            self.db.write_opt(batch, &options)?;
        }
        Ok(AppendResult {
            inserted,
            ready,
            pending: pending.len(),
            vector: Some(frontier.iter().map(|(k, v)| (*k, *v)).collect()),
        })
    }

    /// The rows still held, with spans computed from the next one, and a gap
    /// row where none holds the remote clock, as `SqliteStore` serves them.
    fn read_missing(
        &self,
        doc_id: &str,
        prefix: &[u8],
        frontier: &BTreeMap<u64, u64>,
        remote: &VersionVector,
    ) -> Result<Vec<PatchRow>> {
        let mut rows = Vec::new();
        let mut cursor = self.cursor(ROWS, prefix)?;
        let mut values = self.cursor(VALUES, prefix)?;
        let held_row = |clock: u64, dependencies, operations: &[u8]| PatchRow {
            doc_id: doc_id.to_owned(),
            sid: 0,
            clock,
            span: 1,
            dependencies,
            operations: operations.to_vec(),
        };
        // One seek per actor that is behind, then its rows in order, and its values.
        for (sid, clock) in frontier {
            let since = own_clock(remote, *sid);
            if *clock <= since {
                continue;
            }
            let mut held = Vec::new();
            let from = row_key(prefix, *sid, since.max(1));
            let actor = &from[..from.len() - 8];
            // The row holding `since` may start before it.
            cursor.seek_for_prev(&from);
            if !cursor.key().is_some_and(|key| key.starts_with(actor)) {
                cursor.status()?;
                cursor.seek(&from);
            }
            // Rows from the actor's clock on are pending.
            let end = row_key(prefix, *sid, *clock);
            while let Some((key, value)) = cursor.item() {
                if key >= end.as_slice() {
                    break;
                }
                let (_, start) = row_key_of(key, prefix).ok_or_else(corrupt)?;
                if value.first() == Some(&FORMAT_PACKED) {
                    for row in unpack(start, value)? {
                        held.push(held_row(row.clock, row.dependencies, &row.operations));
                    }
                } else {
                    let (_, dependencies, operations) = header(value)?;
                    if !is_gap(operations) {
                        held.push(held_row(start, dependencies, operations));
                    }
                }
                cursor.next();
            }
            cursor.status()?;
            values.seek(actor);
            while let Some((key, value)) = values.item() {
                if !key.starts_with(actor) {
                    break;
                }
                let (start, row) = decode_value(value)?;
                held.push(held_row(start, row.dependencies, &row.operations));
                values.next();
            }
            values.status()?;
            held.sort_by_key(|row| row.clock);
            for row in &mut held {
                row.sid = *sid;
            }
            serve(&mut rows, doc_id, *sid, held, since, *clock);
        }
        Ok(rows)
    }
}

/// The rows an actor still holds, sorted by clock, as a peer receives them:
/// each one's span runs to the next one, the last one's to the frontier. A
/// peer whose knowledge ends at `since` gets the row that holds it and those
/// after it, or a gap row up to the first one when no row holds it.
fn serve(
    rows: &mut Vec<PatchRow>,
    doc_id: &str,
    sid: u64,
    held: Vec<PatchRow>,
    since: u64,
    frontier: u64,
) {
    let from = since.max(1);
    let first = held.partition_point(|row| row.clock <= from);
    if first == 0 {
        let end = held.first().map_or(frontier, |row| row.clock);
        rows.push(PatchRow {
            doc_id: doc_id.to_owned(),
            sid,
            clock: from,
            span: end - from,
            dependencies: if from > 1 { vec![(sid, from)] } else { vec![] },
            operations: GAP_OPERATIONS.to_vec(),
        });
    }
    let ends: Vec<u64> = held
        .iter()
        .skip(1)
        .map(|row| row.clock)
        .chain([frontier])
        .collect();
    for (row, end) in held.into_iter().zip(ends).skip(first.saturating_sub(1)) {
        rows.push(PatchRow {
            span: end - row.clock,
            ..row
        });
    }
}

impl DocumentStore for RocksStore {
    fn is_deleted(&self, doc_id: &str) -> Result<bool> {
        validate_doc_id(doc_id)?;
        let family = self.family(TOMBSTONES)?;
        for prefix in document_prefixes(doc_id) {
            if self.db.get_cf(family, prefix.as_bytes())?.is_some() {
                return Ok(true);
            }
        }
        Ok(false)
    }
    fn delete_documents(&mut self, doc_id: &str, preserve_rows: bool) -> Result<usize> {
        validate_doc_id(doc_id)?;
        let mut batch = WriteBatch::default();
        let lower = format!("{doc_id}/").into_bytes();
        let upper = format!("{doc_id}0").into_bytes();
        let family = self.family(TOMBSTONES)?;
        if !self.is_deleted(doc_id)? {
            batch.delete_range_cf(family, &lower, &upper);
            batch.put_cf(family, doc_id.as_bytes(), []);
        }
        let mut found = BTreeSet::new();
        if !preserve_rows {
            let prefix = prefix_of(doc_id);
            let mut end = prefix.clone();
            *end.last_mut().unwrap() = 1;
            for name in [ROWS, CLOCKS, PENDING, VALUES] {
                let cf = self.family(name)?;
                if name == ROWS || name == VALUES {
                    for (lo, hi) in [(&prefix, &end), (&lower, &upper)] {
                        let mut options = ReadOptions::default();
                        options.set_total_order_seek(true);
                        options.set_iterate_lower_bound(lo.clone());
                        options.set_iterate_upper_bound(hi.clone());
                        let mut cursor = self.db.raw_iterator_cf_opt(cf, options);
                        cursor.seek(lo);
                        while cursor.valid() {
                            let doc = document_prefix(cursor.key().ok_or_else(corrupt)?);
                            found.insert(doc[..doc.len() - 1].to_vec());
                            cursor.next();
                        }
                        cursor.status()?;
                    }
                }
                batch.delete_range_cf(cf, &prefix, &end);
                batch.delete_range_cf(cf, &lower, &upper);
            }
        }
        // A deletion is durable even when ordinary appends use relaxed WAL sync.
        let mut options = WriteOptions::default();
        options.set_sync(true);
        self.db.write_opt(batch, &options)?;
        self.documents.retain(|id, _| !covers_document(doc_id, id));
        Ok(found.len())
    }
    fn recover_rows(&self, doc_id: &str) -> Result<Vec<PatchRow>> {
        validate_doc_id(doc_id)?;
        let prefix = prefix_of(doc_id);
        self.read_missing(doc_id, &prefix, &self.read_frontier(&prefix)?, &vec![])
    }
    fn documents(&self, doc_id: &str, after: &str, limit: usize) -> Result<Vec<String>> {
        self.assert_live(doc_id)?;
        if limit == 0 || limit > 4096 {
            return Err(Error::new("INVALID_MESSAGE", "Invalid document limit"));
        }
        let mut result = Vec::new();
        let exact = prefix_of(doc_id);
        let mut exact_end = exact.clone();
        *exact_end.last_mut().unwrap() = 1;
        for (mut lower, upper) in [
            (exact, exact_end),
            (
                format!("{doc_id}/").into_bytes(),
                format!("{doc_id}0").into_bytes(),
            ),
        ] {
            // All actor keys for `after` sort below its NUL changed to 1.
            let mut resume = prefix_of(after);
            *resume.last_mut().unwrap() = 1;
            if resume > lower {
                lower = resume;
            }
            if lower >= upper {
                continue;
            }
            let mut options = ReadOptions::default();
            options.set_total_order_seek(true);
            options.set_iterate_lower_bound(lower.clone());
            options.set_iterate_upper_bound(upper);
            let mut cursor = self.db.raw_iterator_cf_opt(self.family(CLOCKS)?, options);
            cursor.seek(&lower);
            while cursor.valid() {
                let prefix = document_prefix(cursor.key().ok_or_else(corrupt)?);
                let id = std::str::from_utf8(&prefix[..prefix.len() - 1]).map_err(|_| corrupt())?;
                if !self.is_deleted(id)? {
                    result.push(id.to_owned());
                }
                if result.len() == limit {
                    break;
                }
                // Hop to the next document without walking all of its actors.
                let mut next = prefix.to_vec();
                *next.last_mut().unwrap() = 1;
                cursor.seek(next);
            }
            cursor.status()?;
            if result.len() == limit {
                break;
            }
        }
        Ok(result)
    }
}

impl PatchStore for RocksStore {
    type Error = Error;
    fn append(&mut self, rows: &[PatchRow]) -> Result<AppendResult> {
        RocksStore::append(self, rows)
    }
    fn vector(&self, doc_id: &str) -> Result<VersionVector> {
        RocksStore::vector(self, doc_id)
    }
    fn missing(&self, doc_id: &str, remote: &VersionVector) -> Result<Vec<PatchRow>> {
        RocksStore::missing(self, doc_id, remote)
    }
    fn sync_state(
        &mut self,
        doc_id: &str,
        remote: &VersionVector,
    ) -> Result<(Vec<PatchRow>, VersionVector)> {
        RocksStore::sync_state(self, doc_id, remote)
    }
}

pub fn validate_doc_id(doc_id: &str) -> Result<()> {
    Ok(pulsify_protocol::validate_doc_id(doc_id)?)
}

fn prefix_of(doc_id: &str) -> Vec<u8> {
    let mut prefix = Vec::with_capacity(doc_id.len() + 17);
    prefix.extend_from_slice(doc_id.as_bytes());
    prefix.push(0);
    prefix
}
fn row_key(prefix: &[u8], sid: u64, clock: u64) -> Vec<u8> {
    let mut key = Vec::with_capacity(prefix.len() + 16);
    key.extend_from_slice(prefix);
    key.extend_from_slice(&sid.to_be_bytes());
    key.extend_from_slice(&clock.to_be_bytes());
    key
}
fn value_key(prefix: &[u8], sid: u64, register: &[u8]) -> Vec<u8> {
    let mut key = Vec::with_capacity(prefix.len() + 8 + register.len());
    key.extend_from_slice(prefix);
    key.extend_from_slice(&sid.to_be_bytes());
    key.extend_from_slice(register);
    key
}
fn integer(bytes: &[u8]) -> Option<u64> {
    Some(u64::from_be_bytes(bytes.try_into().ok()?))
}
fn row_key_of(key: &[u8], prefix: &[u8]) -> Option<(u64, u64)> {
    let rest = key.get(prefix.len()..).filter(|rest| rest.len() == 16)?;
    Some((integer(&rest[..8])?, integer(&rest[8..])?))
}

fn corrupt() -> Error {
    Error::new("CONNECTION_FAILED", "Corrupt stored row")
}
fn conflict(message: &str) -> Error {
    Error::new("CONFLICT", message)
}
fn own_clock(vv: &VersionVector, sid: u64) -> u64 {
    vv.iter()
        .find(|(id, _)| *id == sid)
        .map_or(0, |(_, clock)| *clock)
}
/// Other operations at the same identity. A gap row stands for any replaced write.
fn differ(held: &[u8], incoming: &[u8]) -> bool {
    !is_gap(held) && !is_gap(incoming) && held != incoming
}
fn covered(frontier: &BTreeMap<u64, u64>, dependencies: &VersionVector) -> bool {
    dependencies
        .iter()
        .all(|(actor, clock)| frontier.get(actor).copied().unwrap_or(0) >= *clock)
}

fn varuint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 128 {
        out.push(value as u8 | 128);
        value >>= 7;
    }
    out.push(value as u8);
}
fn read_varuint(bytes: &[u8], offset: &mut usize) -> Result<u64> {
    let mut value = 0u64;
    for shift in (0..64).step_by(7) {
        let byte = *bytes.get(*offset).ok_or_else(corrupt)?;
        *offset += 1;
        value |= u64::from(byte & 127) << shift;
        if byte < 128 {
            return Ok(value);
        }
    }
    Err(corrupt())
}
/// Span and dependencies as LEB128 varuints, like the rows of a packed
/// SQLite segment.
fn encode_header(out: &mut Vec<u8>, span: u64, dependencies: &VersionVector) {
    out.push(FORMAT_ROW);
    varuint(out, span);
    varuint(out, dependencies.len() as u64);
    for (sid, clock) in dependencies {
        varuint(out, *sid);
        varuint(out, *clock);
    }
}
fn encode(row: &Held<'_>) -> Vec<u8> {
    let mut value = Vec::with_capacity(row.operations.len() + 8 + row.dependencies.len() * 12);
    push_row(&mut value, row);
    value
}
fn push_row(value: &mut Vec<u8>, row: &Held<'_>) {
    encode_header(value, row.span, &row.dependencies);
    value.extend_from_slice(&row.operations);
}
fn varuint_bytes(value: u64) -> usize {
    (u64::BITS - value.leading_zeros()).max(1).div_ceil(7) as usize
}
fn row_bytes(row: &Held<'_>) -> usize {
    1 + varuint_bytes(row.span)
        + varuint_bytes(row.dependencies.len() as u64)
        + row
            .dependencies
            .iter()
            .map(|(sid, clock)| varuint_bytes(*sid) + varuint_bytes(*clock))
            .sum::<usize>()
        + row.operations.len()
}

/// A packed row starts at the key's clock. Each part is a length-prefixed
/// ordinary row; its span provides the start of the next one.
fn unpack(mut clock: u64, value: &[u8]) -> Result<Vec<Held<'_>>> {
    let mut data = value.strip_prefix(&[FORMAT_PACKED]).ok_or_else(corrupt)?;
    if data.is_empty() || value.len() > MAX_PACKED_BYTES {
        return Err(corrupt());
    }
    let mut rows = Vec::new();
    while !data.is_empty() {
        if rows.len() == MAX_PACKED_ROWS {
            return Err(corrupt());
        }
        let mut offset = 0;
        let size = usize::try_from(read_varuint(data, &mut offset)?).map_err(|_| corrupt())?;
        let end = offset.checked_add(size).ok_or_else(corrupt)?;
        let (span, dependencies, operations) = header(data.get(offset..end).ok_or_else(corrupt)?)?;
        if operations.is_empty() {
            return Err(corrupt());
        }
        rows.push(Held {
            clock,
            span,
            dependencies,
            operations: Cow::Borrowed(operations),
        });
        clock = clock
            .checked_add(span)
            .filter(|end| *end <= MAX_SAFE_INTEGER)
            .ok_or_else(corrupt)?;
        data = &data[end..];
    }
    Ok(rows)
}
/// A value: the clock of its write, then the row as `rows` encodes it.
fn encode_value(row: &Held<'_>) -> Vec<u8> {
    let mut value = row.clock.to_be_bytes().to_vec();
    value.extend(encode(row));
    value
}
fn decode_value(value: &[u8]) -> Result<(u64, Held<'static>)> {
    let clock = value.get(..8).and_then(integer).ok_or_else(corrupt)?;
    Ok((clock, Held::stored(clock, &value[8..])?))
}
/// The span and dependencies of a stored value, and what follows them: the operations.
fn header(value: &[u8]) -> Result<(u64, VersionVector, &[u8])> {
    if value.first() != Some(&FORMAT_ROW) {
        return Err(corrupt());
    }
    let mut offset = 1;
    let span = read_varuint(value, &mut offset)?;
    let count = read_varuint(value, &mut offset)?;
    if span == 0 || count > MAX_VECTOR_ENTRIES as u64 {
        return Err(corrupt());
    }
    let mut dependencies = VersionVector::with_capacity(count as usize);
    for _ in 0..count {
        dependencies.push((
            read_varuint(value, &mut offset)?,
            read_varuint(value, &mut offset)?,
        ));
    }
    Ok((span, dependencies, &value[offset..]))
}

/// A row of one actor, as an append reads it or is about to write it.
#[derive(Clone)]
struct Held<'r> {
    clock: u64,
    span: u64,
    dependencies: VersionVector,
    /// Borrowed from the rows being appended, copied from the database.
    operations: Cow<'r, [u8]>,
}
impl Held<'_> {
    fn stored(clock: u64, value: &[u8]) -> Result<Self> {
        let (span, dependencies, operations) = header(value)?;
        Ok(Held {
            clock,
            span,
            dependencies,
            operations: Cow::Owned(operations.to_vec()),
        })
    }
    fn into_owned(self) -> Held<'static> {
        Held {
            clock: self.clock,
            span: self.span,
            dependencies: self.dependencies,
            operations: Cow::Owned(self.operations.into_owned()),
        }
    }
}

/// What a batch does to a row: `None` removes it.
struct Change<'r> {
    value: Option<Held<'r>>,
    /// Whether the database holds a row at this key.
    stored: bool,
}

/// The rows and values of one document as an append sees them: those of the
/// database, under the changes of its batch, which is written at the end.
struct View<'a, 'r> {
    store: &'a RocksStore,
    prefix: &'a [u8],
    cursor: Option<DBRawIterator<'a>>,
    rows: BTreeMap<(u64, u64), Change<'r>>,
    /// The last segment read, so resends can reuse its decoded rows.
    packed: Option<(u64, Vec<Held<'static>>)>,
    /// Values the batch writes, by actor and register.
    values: BTreeMap<(u64, Vec<u8>), Held<'r>>,
    /// The clocks of an actor's stored values, read once for rows sent again.
    actor_values: HashMap<u64, HashMap<u64, Vec<u8>>>,
}
impl<'a, 'r> View<'a, 'r> {
    fn cursor(&mut self) -> Result<&mut DBRawIterator<'a>> {
        if self.cursor.is_none() {
            self.cursor = Some(self.store.cursor(ROWS, self.prefix)?);
        }
        Ok(self.cursor.as_mut().expect("created above"))
    }
    /// The row that starts at this sequence number.
    fn get(&mut self, sid: u64, clock: u64) -> Result<Option<Held<'r>>> {
        if let Some(change) = self.rows.get(&(sid, clock)) {
            return Ok(change.value.clone());
        }
        if let Some((actor, rows)) = &self.packed {
            let last = rows.last().expect("a segment is nonempty");
            if *actor == sid && rows[0].clock <= clock && clock < last.clock + last.span {
                return Ok(rows.iter().find(|row| row.clock == clock).cloned());
            }
        }
        let key = row_key(self.prefix, sid, clock);
        let prefix = self.prefix;
        let packed_layout = self.store.db.cf_handle(PACKED_LAYOUT).is_some();
        let cursor = self.cursor()?;
        // The operation could be inside a segment indexed by an earlier clock.
        if packed_layout {
            cursor.seek_for_prev(&key);
        } else {
            cursor.seek(&key);
        }
        let mut decoded = None;
        let mut found = None;
        if let Some((key, value)) = cursor.item() {
            let (actor, first) = row_key_of(key, prefix).ok_or_else(corrupt)?;
            if actor == sid {
                if value.first() == Some(&FORMAT_PACKED) {
                    let rows: Vec<_> = unpack(first, value)?
                        .into_iter()
                        .map(Held::into_owned)
                        .collect();
                    found = rows.iter().find(|row| row.clock == clock).cloned();
                    decoded = Some(rows);
                } else if first == clock {
                    found = Some(Held::stored(clock, value)?);
                }
            }
        }
        cursor.status()?;
        if let Some(rows) = decoded {
            self.packed = Some((sid, rows));
        }
        Ok(found)
    }
    /// The nearest row of the actor that starts before this sequence number
    /// (`forward` false) or after it, whatever lies between.
    fn neighbour(&mut self, sid: u64, clock: u64, forward: bool) -> Result<Option<Held<'r>>> {
        let changed = if forward {
            let mut later = self.rows.range((sid, clock + 1)..=(sid, u64::MAX));
            later.find_map(|change| change.1.value.clone())
        } else {
            let mut earlier = self.rows.range((sid, 0)..(sid, clock)).rev();
            earlier.find_map(|change| change.1.value.clone())
        };
        if !forward && clock == 0 {
            return Ok(changed);
        }
        let prefix = self.prefix;
        let from = row_key(prefix, sid, if forward { clock + 1 } else { clock - 1 });
        if self.cursor.is_none() {
            self.cursor = Some(self.store.cursor(ROWS, prefix)?);
        }
        let cursor = self.cursor.as_mut().expect("created above");
        if forward {
            cursor.seek(&from);
        } else {
            cursor.seek_for_prev(&from);
        }
        let mut stored = None;
        while let Some((key, value)) = cursor.item() {
            let (actor, start) = row_key_of(key, prefix).ok_or_else(corrupt)?;
            if actor != sid {
                break;
            }
            if !self.rows.contains_key(&(sid, start)) {
                stored = if value.first() != Some(&FORMAT_PACKED) {
                    Some(Held::stored(start, value)?)
                } else {
                    // Forward checks start at or beyond the frontier, after
                    // every packed row. A backward check can find a segment.
                    let mut rows = unpack(start, value)?.into_iter();
                    let row = if forward {
                        rows.next()
                    } else {
                        rows.next_back()
                    };
                    row.map(Held::into_owned)
                };
                break;
            }
            // The batch changed or removed this row, which `changed` covers: look further.
            if forward {
                cursor.next();
            } else {
                cursor.prev();
            }
        }
        cursor.status()?;
        Ok(match (changed, stored) {
            (Some(changed), Some(stored)) => Some(if (changed.clock < stored.clock) == forward {
                changed
            } else {
                stored
            }),
            (changed, stored) => changed.or(stored),
        })
    }
    fn before(&mut self, sid: u64, clock: u64) -> Result<Option<Held<'r>>> {
        self.neighbour(sid, clock, false)
    }
    fn after(&mut self, sid: u64, clock: u64) -> Result<Option<Held<'r>>> {
        self.neighbour(sid, clock, true)
    }
    /// Stores a row at a key that the database does not hold.
    fn insert(&mut self, sid: u64, row: Held<'r>) {
        match self.rows.get_mut(&(sid, row.clock)) {
            Some(change) => change.value = Some(row),
            None => {
                let key = (sid, row.clock);
                let change = Change {
                    value: Some(row),
                    stored: false,
                };
                self.rows.insert(key, change);
            }
        }
    }
    /// Rewrites a row that was read through this view.
    fn update(&mut self, sid: u64, row: Held<'r>) {
        match self.rows.get_mut(&(sid, row.clock)) {
            Some(change) => change.value = Some(row),
            None => {
                let key = (sid, row.clock);
                let change = Change {
                    value: Some(row),
                    stored: true,
                };
                self.rows.insert(key, change);
            }
        }
    }
    fn remove(&mut self, sid: u64, clock: u64) {
        let key = (sid, clock);
        match self.rows.get_mut(&key) {
            Some(change) if change.stored => change.value = None,
            // The batch added it: the database never sees it.
            Some(_) => {
                self.rows.remove(&key);
            }
            None => {
                let change = Change {
                    value: None,
                    stored: true,
                };
                self.rows.insert(key, change);
            }
        }
    }
    /// Stores a ready row: a last-value row as its actor's value of the
    /// register, replacing the older one; a gap row not at all, as the clock
    /// says how far the actor goes. Whether it stays a row.
    fn keep(&mut self, sid: u64, row: &Held<'r>) -> bool {
        let Some(last) = last_register_of(&row.operations) else {
            return !is_gap(&row.operations);
        };
        self.values
            .insert((sid, last.register.to_vec()), row.clone());
        false
    }
    /// The operations held at this sequence number: a row, or a value.
    fn held_at(&mut self, sid: u64, clock: u64) -> Result<Option<Vec<u8>>> {
        if let Some(row) = self.get(sid, clock)? {
            return Ok(Some(row.operations.into_owned()));
        }
        let held = self
            .values
            .range((sid, Vec::new())..)
            .take_while(|((actor, _), _)| *actor == sid)
            .find(|(_, row)| row.clock == clock)
            .map(|(_, row)| row.operations.to_vec());
        if held.is_some() {
            return Ok(held);
        }
        if !self.actor_values.contains_key(&sid) {
            let mut clocks = HashMap::new();
            let actor = value_key(self.prefix, sid, &[]);
            let mut cursor = self.store.cursor(VALUES, self.prefix)?;
            cursor.seek(&actor);
            while let Some((key, value)) = cursor.item() {
                if !key.starts_with(&actor) {
                    break;
                }
                clocks.insert(decode_value(value)?.0, key[actor.len()..].to_vec());
                cursor.next();
            }
            cursor.status()?;
            self.actor_values.insert(sid, clocks);
        }
        let Some(register) = self.actor_values[&sid].get(&clock) else {
            return Ok(None);
        };
        // The batch may have overwritten it since.
        if self.values.contains_key(&(sid, register.clone())) {
            return Ok(None);
        }
        let key = value_key(self.prefix, sid, register);
        let value = self.store.db.get_cf(self.store.family(VALUES)?, key)?;
        Ok(match value {
            Some(value) => Some(decode_value(&value)?.1.operations.into_owned()),
            None => None,
        })
    }
    /// Adds the changes to the batch and reports whether it contains a segment.
    fn write(self, batch: &mut WriteBatch, frontier: &BTreeMap<u64, u64>) -> Result<bool> {
        let rows = self.store.family(ROWS)?;
        let mut changes = self.rows.iter().peekable();
        let mut run = Vec::new();
        let mut packed = false;
        while let Some((&(sid, clock), change)) = changes.next() {
            let key = row_key(self.prefix, sid, clock);
            let Some(row) = &change.value else {
                batch.delete_cf(rows, key);
                continue;
            };
            if !self.store.pack_appends || change.stored || changes.len() < MIN_PACKED_ROWS - 1 {
                batch.put_cf(rows, key, encode(row));
                continue;
            }
            let mut end = clock + row.span;
            let ready = frontier.get(&sid).copied().unwrap_or(1);
            if end > ready {
                batch.put_cf(rows, key, encode(row));
                continue;
            }
            let size = row_bytes(row);
            let mut bytes = 1 + varuint_bytes(size as u64) + size;
            run.push((row, size));
            while let Some((&(next_sid, next_clock), change)) = changes.peek().copied() {
                let Some(next) = &change.value else { break };
                if next_sid != sid
                    || next_clock != end
                    || change.stored
                    || next_clock + next.span > ready
                    || run.len() == MAX_PACKED_ROWS
                {
                    break;
                }
                let size = row_bytes(next);
                let total = bytes + varuint_bytes(size as u64) + size;
                // Keep short operations in the same RocksDB blocks as
                // ordinary rows, below the threshold for blob files.
                if total > MAX_PACKED_BYTES {
                    break;
                }
                run.push((next, size));
                changes.next();
                end += next.span;
                bytes = total;
            }
            if run.len() >= MIN_PACKED_ROWS {
                let mut value = Vec::with_capacity(bytes);
                value.push(FORMAT_PACKED);
                for (row, size) in run.drain(..) {
                    varuint(&mut value, size as u64);
                    push_row(&mut value, row);
                }
                batch.put_cf(rows, key, value);
                packed = true;
            } else {
                for (row, _) in run.drain(..) {
                    batch.put_cf(rows, row_key(self.prefix, sid, row.clock), encode(row));
                }
            }
        }
        let values = self.store.family(VALUES)?;
        for ((sid, register), row) in &self.values {
            let key = value_key(self.prefix, *sid, register);
            batch.put_cf(values, key, encode_value(row));
        }
        Ok(packed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rocksdb::IteratorMode;

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
    fn next(sid: u64, clock: u64, span: u64) -> PatchRow {
        if clock == 1 {
            row(sid, 1, span, &[])
        } else {
            row(sid, clock, span, &[(sid, clock)])
        }
    }
    /// Every key and value of the column families.
    fn dump(store: &RocksStore) -> Vec<(&'static str, Vec<u8>, Vec<u8>)> {
        let mut entries = Vec::new();
        for name in FAMILIES {
            let family = store.family(name).unwrap();
            let mut options = ReadOptions::default();
            options.set_total_order_seek(true);
            for entry in store
                .db()
                .iterator_cf_opt(family, options, IteratorMode::Start)
            {
                let (key, value) = entry.unwrap();
                entries.push((name, key.into_vec(), value.into_vec()));
            }
        }
        entries
    }
    fn directory(name: &str) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("pulsify-rocksdb-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    #[test]
    fn packed_history_survives_reopen_with_ordinary_rows() {
        let path = directory("packed-history");
        let mut store = RocksStore::open(&path).unwrap();
        store.set_pack_appends(false);
        let mut history = vec![next(A, 1, 2), next(A, 3, 2)];
        history.extend((5..=10).map(|clock| next(A, clock, 1)));
        history.push(next(A, 11, 2));
        history.extend((13..=83).map(|clock| next(A, clock, 1)));
        store.append(&history[..8]).unwrap();
        assert!(store.db().cf_handle(PACKED_LAYOUT).is_none());
        drop(store);
        // The column families recognized by a store from before packing.
        drop(DB::open_cf(&database_options(), &path, FAMILIES).unwrap());

        let mut store = RocksStore::open(&path).unwrap();
        assert_eq!(store.missing("doc", &vec![]).unwrap(), history[..8]);
        assert!(store.db().cf_handle(PACKED_LAYOUT).is_none());
        let mut rejected = history[8..].to_vec();
        let mut changed = history[0].clone();
        changed.operations.push(42);
        rejected.push(changed);
        assert_eq!(store.append(&rejected).unwrap_err().code, "CONFLICT");
        assert!(store.db().cf_handle(PACKED_LAYOUT).is_none());

        let result = store.append(&history[8..]).unwrap();
        assert_eq!((result.inserted, result.ready, result.pending), (72, 72, 0));
        assert_eq!(result.vector, Some(vec![(A, 84)]));
        let entries = dump(&store);
        let formats: Vec<_> = entries
            .iter()
            .filter(|(family, _, _)| *family == ROWS)
            .map(|(_, _, bytes)| bytes[0])
            .collect();
        assert_eq!(formats[..8], [FORMAT_ROW; 8]);
        assert_eq!(formats[8..], [FORMAT_PACKED; 2]);

        drop(store);
        // The set of column families the old store knew how to open.
        let refused = DB::open_cf(&database_options(), &path, FAMILIES);
        assert!(matches!(refused, Err(error) if error.to_string().contains(PACKED_LAYOUT)));
        let mut store = RocksStore::open(&path).unwrap();
        assert_eq!(store.missing("doc", &vec![]).unwrap(), history);
        assert_eq!(store.missing("doc", &vec![(A, 12)]).unwrap(), &history[8..]);
        assert_eq!(store.append(&history).unwrap().inserted, 0);

        let tail: Vec<_> = (84..92).map(|clock| next(A, clock, 1)).collect();
        store.append(&tail).unwrap();
        store.set_pack_appends(false);
        let ordinary: Vec<_> = (92..100).map(|clock| next(A, clock, 1)).collect();
        store.append(&ordinary).unwrap();
        let entries = dump(&store);
        let count_format = |format| {
            entries
                .iter()
                .filter(|(family, _, value)| *family == ROWS && value[0] == format)
                .count()
        };
        assert_eq!(count_format(FORMAT_ROW), 16);
        assert_eq!(count_format(FORMAT_PACKED), 3);
        store.delete_documents("doc", true).unwrap();
        history.extend(tail);
        history.extend(ordinary);
        assert_eq!(store.recover_rows("doc").unwrap(), history);
        assert_eq!(store.delete_documents("doc", false).unwrap(), 1);
        assert!(store.recover_rows("doc").unwrap().is_empty());
        drop(store);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn packed_history_checks_resends_and_neighbour_forks() {
        let mut store = RocksStore::open_in_memory().unwrap();
        let mut history: Vec<_> = (1..8).map(|clock| next(A, clock, 1)).collect();
        history.push(next(A, 8, 2));
        store.append(&history).unwrap();
        let before = dump(&store);
        let sequence = store.db().latest_sequence_number();
        let mut changed = history[4].clone();
        changed.operations.push(42);
        let in_order = next(A, 10, 1);
        assert_eq!(
            store.append(&[in_order.clone(), changed]).unwrap_err().code,
            "CONFLICT"
        );
        let fork = row(A, 11, 1, &[(A, 8)]);
        assert_eq!(store.append(&[fork]).unwrap_err().code, "CONFLICT");
        assert_eq!(store.db().latest_sequence_number(), sequence);
        assert_eq!(dump(&store), before);

        store.set_pack_appends(false);
        assert_eq!(store.append(&history[4..5]).unwrap().inserted, 0);
        let pending = next(A, 11, 1);
        assert_eq!(
            store
                .append(std::slice::from_ref(&pending))
                .unwrap()
                .pending,
            1
        );
        let result = store.append(std::slice::from_ref(&in_order)).unwrap();
        assert_eq!((result.ready, result.pending), (2, 0));
        history.extend([in_order, pending]);
        assert_eq!(store.missing("doc", &vec![]).unwrap(), history);
    }

    #[test]
    fn packed_history_keeps_large_operations_pending_rows_and_values_separate() {
        let mut store = RocksStore::open_in_memory().unwrap();
        let mut batch: Vec<_> = (1..=23)
            .map(|clock| {
                let mut row = next(A, clock, 1);
                let size = if clock == 23 {
                    MIN_BLOB_BYTES as usize
                } else {
                    340
                };
                row.operations = vec![5; size];
                row
            })
            .collect();
        batch.extend([write(A, 24, 1, 0), gap(A, 25, 1), next(B, 2, 1)]);
        let result = store.append(&batch).unwrap();
        assert_eq!(result.pending, 1);
        let entries = dump(&store);
        let segments: Vec<_> = entries
            .iter()
            .filter(|(family, _, value)| *family == ROWS && value[0] == FORMAT_PACKED)
            .collect();
        assert_eq!(segments.len(), 2);
        assert!(segments
            .iter()
            .all(|(_, _, value)| value.len() <= MAX_PACKED_BYTES));
        assert_eq!(
            entries
                .iter()
                .filter(|(family, _, _)| *family == VALUES)
                .count(),
            1
        );
        assert_eq!(
            entries
                .iter()
                .filter(|(family, _, _)| *family == PENDING)
                .count(),
            1
        );

        let mut plain = RocksStore::open_in_memory().unwrap();
        plain.set_pack_appends(false);
        assert_eq!(plain.append(&batch).unwrap(), result);
        assert_eq!(
            store.missing("doc", &vec![]).unwrap(),
            plain.missing("doc", &vec![]).unwrap()
        );
    }

    #[test]
    fn keys_sort_by_document_actor_and_clock() {
        let mut store = RocksStore::open_in_memory().unwrap();
        let wide = row(A, 3, 300, &[(A, 3), (B, 2)]);
        store
            .append(&[next(A, 1, 2), next(B, 1, 1), wide, next(B, 3, 1)])
            .unwrap();
        let key = |sid: u64, clock: Option<u64>| {
            let mut key = b"doc\0".to_vec();
            key.extend(sid.to_be_bytes());
            key.extend(clock.into_iter().flat_map(u64::to_be_bytes));
            key
        };
        // Format, span, dependency count, (sid, clock) pairs as varuints, operations.
        let wide = vec![0, 172, 2, 2, 128, 128, 4, 3, 129, 128, 4, 2, 0, 3, 44];
        assert_eq!(
            dump(&store),
            vec![
                (ROWS, key(A, Some(1)), vec![0, 2, 0, 0, 1, 2]),
                (ROWS, key(A, Some(3)), wide),
                (ROWS, key(B, Some(1)), vec![0, 1, 0, 1, 1, 1]),
                (
                    ROWS,
                    key(B, Some(3)),
                    vec![0, 1, 1, 129, 128, 4, 3, 1, 3, 1]
                ),
                (CLOCKS, key(A, None), 303u64.to_be_bytes().to_vec()),
                (CLOCKS, key(B, None), 2u64.to_be_bytes().to_vec()),
                (PENDING, key(B, Some(3)), vec![0, 1, 1, 129, 128, 4, 3]),
            ]
        );
        // Promoting B's row moves its clock and drops the pending entry: the
        // row is not rewritten.
        store.append(&[next(B, 2, 1)]).unwrap();
        let entries = dump(&store);
        assert_eq!(entries.len(), 7);
        assert_eq!(
            entries[6],
            (CLOCKS, key(B, None), 4u64.to_be_bytes().to_vec())
        );
    }

    #[test]
    fn a_refused_batch_writes_nothing() {
        for cached_documents in [0, 8] {
            let path = directory(&format!("refused-{cached_documents}"));
            let options = RocksOptions {
                cached_documents,
                ..RocksOptions::default()
            };
            let mut store = RocksStore::open_with(&path, &options).unwrap();
            store.append(&[next(A, 1, 2), next(B, 3, 1)]).unwrap();
            let before = dump(&store);
            let sequence = store.db().latest_sequence_number();
            let mut changed = next(A, 1, 2);
            changed.operations = vec![9];
            let too_many: Vec<_> = (0..MAX_VECTOR_ENTRIES as u64)
                .map(|i| next(B + 1 + i, 1 + i % 2, 1))
                .collect();
            for bad in [
                vec![next(A, 3, 1), next(B, 1, 2), next(B, 5, 1), changed],
                vec![
                    next(A, 3, 1),
                    next(B, 1, 2),
                    next(A, 6, 1),
                    row(A, 7, 1, &[(A, 5)]),
                ],
                vec![next(A, 3, 1), next(B, 1, 2), row(A, 4, 1, &[(A, 3)])],
                // After rows of the batch that replace others and move a frontier.
                vec![
                    write(A, 3, 5, 0),
                    write(B, 1, 6, 0),
                    next(B, 1, 4),
                    next(A, 1, 9),
                    next(B, 3, 1),
                ],
                too_many,
            ] {
                assert!(store.append(&bad).is_err());
                assert_eq!(dump(&store), before);
                assert_eq!(store.vector("doc").unwrap(), vec![(A, 3)]);
            }
            // Neither does a resend, which therefore waits for no sync.
            assert_eq!(
                store
                    .append(&[next(B, 3, 1), next(A, 1, 2)])
                    .unwrap()
                    .inserted,
                0
            );
            assert_eq!(store.db().latest_sequence_number(), sequence);
            // The state kept in memory was not left half-updated.
            let result = store.append(&[next(A, 3, 1), next(B, 1, 2)]).unwrap();
            assert_eq!((result.ready, result.pending), (3, 0));
            assert_eq!(result.vector, Some(vec![(A, 4), (B, 4)]));
            drop(store);
            std::fs::remove_dir_all(path).unwrap();
        }
    }

    /// One kind 7 write of `sid` to the numeric field `field` of the node "n":
    /// a last-value row.
    fn write(sid: u64, clock: u64, lamport: u8, field: u8) -> PatchRow {
        PatchRow {
            operations: vec![
                3,
                lamport,
                0,
                1,
                7,
                1,
                b'n',
                1,
                field,
                sid as u8,
                clock as u8,
            ],
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
    fn spans(store: &RocksStore) -> Vec<(u64, u64, u64)> {
        store
            .missing("doc", &vec![])
            .unwrap()
            .iter()
            .map(|row| (row.sid, row.clock, row.span))
            .collect()
    }
    /// How many entries a column family holds.
    fn count(store: &RocksStore, family: &str) -> usize {
        dump(store).iter().filter(|entry| entry.0 == family).count()
    }
    /// The values: actor, field, then the clock of the write that holds it.
    fn values(store: &RocksStore) -> Vec<(u64, u8, u64)> {
        dump(store)
            .iter()
            .filter(|entry| entry.0 == VALUES)
            .map(|(_, key, value)| {
                assert_eq!(key[..4], *b"doc\0");
                assert_eq!(key[12..15], *b"\x01n\x01");
                let sid = integer(&key[4..12]).unwrap();
                (sid, key[15], decode_value(value).unwrap().0)
            })
            .collect()
    }

    #[test]
    fn a_register_rewritten_many_times_keeps_one_row_per_actor() {
        let path = directory("rewritten");
        let mut store = RocksStore::open(&path).unwrap();
        store.append(&[next(A, 1, 1), next(B, 1, 1)]).unwrap();
        for clock in 2..=300u64 {
            // Two registers of A, one of which B also writes, with older times.
            let sequence = store.db().latest_sequence_number();
            let mine = store
                .append(&[write(A, clock, 100, (clock % 2) as u8)])
                .unwrap();
            assert_eq!((mine.inserted, mine.ready, mine.pending), (1, 1, 0));
            // Its value and its actor's clock, nothing else.
            assert_eq!(store.db().latest_sequence_number(), sequence + 2);
            let late = store.append(&[write(B, clock, 1, 0)]).unwrap();
            assert_eq!((late.inserted, late.ready), (1, 1));
            assert_eq!(late.vector, Some(vec![(A, clock + 1), (B, clock + 1)]));
        }
        // Each actor keeps its first row and its last write to each register,
        // whatever the other actor wrote: replicas pick the winner.
        let expected = vec![
            (A, 1, 298),
            (A, 299, 1),
            (A, 300, 1),
            (B, 1, 299),
            (B, 300, 1),
        ];
        assert_eq!(spans(&store), expected);
        assert_eq!(count(&store, ROWS), 2);
        assert_eq!(values(&store), vec![(A, 0, 300), (A, 1, 299), (B, 0, 300)]);
        assert_eq!(
            store.missing("doc", &vec![(A, 299), (B, 301)]).unwrap(),
            vec![write(A, 299, 100, 1), write(A, 300, 100, 0)]
        );
        // Sent again, whole or with the spans a peer holds, nothing is written.
        let sequence = store.db().latest_sequence_number();
        let mut again = store.missing("doc", &vec![]).unwrap();
        again.extend((2..=300).map(|clock| write(A, clock, 100, (clock % 2) as u8)));
        assert_eq!(store.append(&again).unwrap().inserted, 0);
        assert_eq!(store.db().latest_sequence_number(), sequence);
        // The values are read back from the database.
        store.flush().unwrap();
        drop(store);
        let mut store = RocksStore::open(&path).unwrap();
        assert_eq!(spans(&store), expected);
        store.append(&[write(B, 301, 100, 0)]).unwrap();
        store.append(&[write(A, 301, 100, 0)]).unwrap();
        assert_eq!(values(&store), vec![(A, 0, 301), (A, 1, 299), (B, 0, 301)]);
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
        drop(store);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn rewriting_one_field_does_not_slow_down() {
        let path = directory("flat");
        let mut store = RocksStore::open_with(
            &path,
            &RocksOptions {
                sync: false,
                ..RocksOptions::default()
            },
        )
        .unwrap();
        store.append(&[next(A, 1, 1)]).unwrap();
        let mut rounds = Vec::new();
        for round in 0..6u64 {
            let start = std::time::Instant::now();
            for clock in 2 + round * 2000..2 + (round + 1) * 2000 {
                store.append(&[write(A, clock, 1, 0)]).unwrap();
            }
            rounds.push(start.elapsed());
        }
        eprintln!("2,000 rewrites of one field, six times over: {rounds:?}");
        // Overwriting in place leaves nothing to step over: the last 2,000
        // writes cost about what the first 2,000 did.
        let first = rounds[0].max(std::time::Duration::from_millis(20));
        assert!(rounds[5] < first * 4, "{rounds:?}");
        assert_eq!(count(&store, ROWS), 1);
        assert_eq!(values(&store), vec![(A, 0, 12001)]);
        drop(store);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn every_actor_keeps_its_own_last_write() {
        let mut store = RocksStore::open_in_memory().unwrap();
        store.append(&[next(A, 1, 1), write(A, 2, 9, 0)]).unwrap();
        // An older write of another actor is kept: it is that actor's last one.
        let late = store.append(&[next(B, 1, 1), write(B, 2, 3, 0)]).unwrap();
        assert_eq!((late.inserted, late.ready, late.pending), (2, 2, 0));
        assert_eq!(
            spans(&store),
            vec![(A, 1, 1), (A, 2, 1), (B, 1, 1), (B, 2, 1)]
        );
        // On promotion: it waited for the row before it, and replaces B's value.
        let waiting = store.append(&[write(B, 4, 4, 0), next(B, 5, 1)]).unwrap();
        assert_eq!((waiting.ready, waiting.pending), (0, 2));
        let filled = store.append(&[next(B, 3, 1)]).unwrap();
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
        assert_eq!(values(&store), vec![(A, 0, 2), (B, 0, 4)]);
        assert_eq!(count(&store, PENDING), 0);
        store.append(&[write(B, 6, 10, 0)]).unwrap();
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
        assert_eq!(values(&store), vec![(A, 0, 2), (B, 0, 6)]);
        assert_eq!(store.vector("doc").unwrap(), vec![(A, 3), (B, 7)]);
        // Other kinds and transactions of several operations are history: kept.
        let mut kept = write(A, 3, 50, 0);
        kept.operations[3] = 2;
        let mut plain = write(A, 4, 50, 0);
        plain.operations[4] = 1;
        store.append(&[kept, plain]).unwrap();
        assert_eq!(count(&store, ROWS), 6);
        assert_eq!(values(&store), vec![(A, 0, 2), (B, 0, 6)]);
    }

    #[test]
    fn replaced_writes_are_served_as_spans_and_gap_rows() {
        let mut store = RocksStore::open_in_memory().unwrap();
        store.append(&[write(A, 1, 1, 0)]).unwrap();
        store.append(&[write(B, 1, 2, 0)]).unwrap();
        assert_eq!(
            store.missing("doc", &vec![]).unwrap(),
            vec![write(A, 1, 1, 0), write(B, 1, 2, 0)]
        );
        // Nothing holds A's first sequence numbers any more: a gap row stands
        // for them, depending on what came before it.
        store
            .append(&[write(A, 2, 1, 0), write(A, 3, 1, 0)])
            .unwrap();
        assert_eq!(
            store.missing("doc", &vec![(B, 2)]).unwrap(),
            vec![gap(A, 1, 2), write(A, 3, 1, 0)]
        );
        assert_eq!(
            store.missing("doc", &vec![(A, 2), (B, 2)]).unwrap(),
            vec![gap(A, 2, 1), write(A, 3, 1, 0)]
        );
        assert_eq!(count(&store, ROWS), 0);
        // A peer sends a gap row where this store holds a row, and the reverse:
        // neither is a conflict, and the row that is held stays.
        let result = store.append(&[gap(B, 1, 1), write(A, 1, 1, 0)]).unwrap();
        assert_eq!(result.inserted, 0);
        // A gap row that arrives only moves the frontier.
        let sequence = store.db().latest_sequence_number();
        store.append(&[gap(B, 2, 3), gap(A + 2, 1, 2)]).unwrap();
        assert_eq!(store.db().latest_sequence_number(), sequence + 2);
        assert_eq!(
            spans(&store),
            vec![(A, 1, 2), (A, 3, 1), (B, 1, 4), (A + 2, 1, 2)]
        );
        // A hole between history rows.
        store
            .append(&[next(B, 5, 1), write(B, 6, 3, 1), next(B, 7, 1)])
            .unwrap();
        store.append(&[write(B, 8, 4, 1), next(B, 9, 1)]).unwrap();
        let only_b = |remote: VersionVector| -> Vec<PatchRow> {
            let rows = store.missing("doc", &remote).unwrap();
            rows.into_iter().filter(|row| row.sid == B).collect()
        };
        assert_eq!(
            only_b(vec![(B, 7)]),
            vec![next(B, 7, 1), write(B, 8, 4, 1), next(B, 9, 1)]
        );
        assert_eq!(
            only_b(vec![(B, 6)]),
            vec![
                PatchRow {
                    span: 2,
                    ..next(B, 5, 1)
                },
                next(B, 7, 1),
                write(B, 8, 4, 1),
                next(B, 9, 1)
            ]
        );
        assert_eq!(values(&store), vec![(A, 0, 3), (B, 0, 1), (B, 1, 8)]);
    }

    #[test]
    fn other_contents_at_a_stored_identity_still_conflict() {
        let mut store = RocksStore::open_in_memory().unwrap();
        store
            .append(&[next(A, 1, 1), write(A, 2, 5, 0), next(A, 5, 2)])
            .unwrap();
        let before = dump(&store);
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
            let error = store.append(&[next(B, 1, 1), bad]).unwrap_err();
            assert_eq!(
                (error.code, error.message.as_str()),
                ("CONFLICT", "Conflicting storage segment")
            );
            assert_eq!(dump(&store), before);
        }
        assert_eq!(store.vector("doc").unwrap(), vec![(A, 3)]);
        // Once replaced, a row is no longer compared: its sequence number holds nothing.
        store.append(&[write(A, 3, 6, 0)]).unwrap();
        assert_eq!(spans(&store), vec![(A, 1, 2), (A, 3, 1)]);
        let replaced = changed(write(A, 2, 5, 0));
        assert_eq!(store.append(&[replaced]).unwrap().inserted, 0);
        // A row of the same batch is compared too.
        let error = store
            .append(&[write(A, 4, 7, 1), changed(write(A, 4, 7, 1))])
            .unwrap_err();
        assert_eq!(error.code, "CONFLICT");
        let error = store.append(&[changed(next(A, 1, 2))]).unwrap_err();
        assert_eq!(error.code, "CONFLICT");
    }

    #[test]
    fn moves_the_register_index_to_values() {
        // The unreleased layout: one row per register, indexed, spans grown
        // over replaced writes, and gap rows where no row could grow.
        let path = directory("registers");
        let a3 = write(A, 3, 5, 0);
        let b2 = write(B, 2, 7, 1);
        {
            let mut options = database_options();
            options.create_missing_column_families(true);
            let db = DB::open_cf(&options, &path, [ROWS, CLOCKS, PENDING, REGISTERS]).unwrap();
            let put = |family: &str, key: Vec<u8>, value: Vec<u8>| {
                db.put_cf(db.cf_handle(family).unwrap(), key, value)
                    .unwrap();
            };
            let prefix = b"doc\0";
            for row in [
                next(A, 1, 2),
                a3.clone(),
                gap(B, 1, 1),
                b2.clone(),
                gap(B, 5, 1),
            ] {
                let held = Held {
                    clock: row.clock,
                    span: row.span,
                    dependencies: row.dependencies.clone(),
                    operations: Cow::Owned(row.operations.clone()),
                };
                put(ROWS, row_key(prefix, row.sid, row.clock), encode(&held));
            }
            for (sid, clock) in [(A, 4u64), (B, 3)] {
                let mut key = prefix.to_vec();
                key.extend(sid.to_be_bytes());
                put(CLOCKS, key, clock.to_be_bytes().to_vec());
            }
            let mut pending = Vec::new();
            encode_header(&mut pending, 1, &vec![(B, 5)]);
            put(PENDING, row_key(prefix, B, 5), pending);
            for (row, lamport) in [(&a3, 5u64), (&b2, 7)] {
                let mut key = prefix.to_vec();
                key.extend(last_register_of(&row.operations).unwrap().register);
                let mut value = row.sid.to_be_bytes().to_vec();
                value.extend(row.clock.to_be_bytes());
                value.extend(lamport.to_be_bytes());
                put(REGISTERS, key, value);
            }
        }
        let mut store = RocksStore::open(&path).unwrap();
        assert!(!DB::list_cf(&Options::default(), &path)
            .unwrap()
            .contains(&REGISTERS.to_owned()));
        assert_eq!(values(&store), vec![(A, 0, 3), (B, 1, 2)]);
        // The waiting gap row stays; the ready one is a hole now.
        assert_eq!(count(&store, ROWS), 2);
        assert_eq!(
            store.missing("doc", &vec![]).unwrap(),
            vec![next(A, 1, 2), a3, gap(B, 1, 1), b2]
        );
        let result = store.append(&[next(B, 3, 2), write(A, 4, 6, 0)]).unwrap();
        assert_eq!((result.ready, result.pending), (3, 0));
        assert_eq!(values(&store), vec![(A, 0, 4), (B, 1, 2)]);
        assert_eq!(
            spans(&store),
            vec![(A, 1, 3), (A, 4, 1), (B, 1, 1), (B, 2, 1), (B, 3, 3)]
        );
        drop(store);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn a_known_row_with_a_longer_span_moves_the_frontier() {
        let mut store = RocksStore::open_in_memory().unwrap();
        let (first, second) = (next(A, 1, 1), next(A, 2, 1));
        store.append(&[first.clone(), second.clone()]).unwrap();
        // The sender replaced two writes after the second one.
        let long = PatchRow {
            span: 3,
            ..second.clone()
        };
        let moved = store.append(std::slice::from_ref(&long)).unwrap();
        assert_eq!((moved.inserted, moved.ready, moved.pending), (1, 0, 0));
        assert_eq!(moved.vector, Some(vec![(A, 5)]));
        assert_eq!(
            store.missing("doc", &vec![]).unwrap(),
            vec![first, long.clone()]
        );
        // Sent again, or shorter, it changes nothing; other contents conflict.
        for span in [1, 2, 3] {
            let again = PatchRow {
                span,
                ..second.clone()
            };
            assert_eq!(store.append(&[again]).unwrap().inserted, 0);
        }
        let changed = PatchRow {
            operations: vec![9],
            ..second.clone()
        };
        let error = store.append(&[changed]).unwrap_err();
        assert_eq!(error.message, "Conflicting storage segment");
        let after = next(A, 5, 1);
        assert_eq!(store.append(std::slice::from_ref(&after)).unwrap().ready, 1);
        assert_eq!(
            store.missing("doc", &vec![(A, 3)]).unwrap(),
            vec![long, after]
        );
        // Beyond rows that wait: they were replaced, and the next one is promoted.
        store.append(&[next(A, 8, 1), next(A, 10, 1)]).unwrap();
        assert_eq!(count(&store, PENDING), 2);
        let wide = PatchRow {
            span: 9,
            ..next(A, 1, 1)
        };
        let moved = store.append(&[wide]).unwrap();
        assert_eq!((moved.inserted, moved.ready, moved.pending), (1, 1, 0));
        assert_eq!(
            spans(&store),
            vec![(A, 1, 1), (A, 2, 3), (A, 5, 5), (A, 10, 1)]
        );
        assert_eq!(store.vector("doc").unwrap(), vec![(A, 11)]);
        assert_eq!((count(&store, ROWS), count(&store, PENDING)), (4, 0));
    }

    #[test]
    fn a_row_replaces_the_waiting_rows_that_its_span_covers() {
        for cached_documents in [0, 8] {
            let path = directory(&format!("waiting-{cached_documents}"));
            let options = RocksOptions {
                cached_documents,
                ..RocksOptions::default()
            };
            let mut store = RocksStore::open_with(&path, &options).unwrap();
            // B's gap keeps its row pending beside in-order appends.
            store.append(&[next(B, 3, 1)]).unwrap();
            let both = store.append(&[next(A, 1, 1), next(A, 2, 1)]).unwrap();
            assert_eq!((both.ready, both.pending), (2, 1));
            // Its span says the writes that followed it were replaced.
            let long = next(B, 1, 3);
            let result = store.append(std::slice::from_ref(&long)).unwrap();
            assert_eq!((result.ready, result.pending), (1, 0));
            assert_eq!(store.missing("doc", &vec![(A, 3)]).unwrap(), vec![long]);
            // Waiting rows inserted earlier in the same batch are replaced too.
            let wide = next(A, 3, 2);
            let result = store.append(&[next(A, 4, 1), wide.clone()]).unwrap();
            assert_eq!((result.inserted, result.ready, result.pending), (2, 1, 0));
            assert_eq!(store.vector("doc").unwrap(), vec![(A, 5), (B, 4)]);
            assert_eq!(
                store.missing("doc", &vec![(B, 4)]).unwrap(),
                vec![next(A, 1, 1), next(A, 2, 1), wide]
            );
            // A waiting row that starts inside another waiting row's span is dropped,
            // and of two rows with the same start the longer span is kept.
            let result = store
                .append(&[next(A, 7, 2), next(A, 8, 1), next(A, 10, 1), next(A, 12, 1)])
                .unwrap();
            assert_eq!((result.inserted, result.pending), (3, 3));
            let mut longer = next(A, 7, 2);
            longer.span = 4;
            let result = store.append(&[longer.clone(), next(A, 7, 2)]).unwrap();
            assert_eq!((result.inserted, result.pending), (0, 2));
            assert_eq!(count(&store, PENDING), 2);
            let result = store.append(&[next(A, 5, 2), next(A, 11, 1)]).unwrap();
            assert_eq!((result.ready, result.pending), (4, 0));
            assert_eq!(
                store.missing("doc", &vec![(A, 5), (B, 4)]).unwrap(),
                vec![next(A, 5, 2), longer, next(A, 11, 1), next(A, 12, 1)]
            );
            assert_eq!((count(&store, ROWS), count(&store, PENDING)), (8, 0));
            drop(store);
            std::fs::remove_dir_all(path).unwrap();
        }
    }

    #[test]
    fn a_waiting_row_that_learns_a_longer_span_replaces_the_rows_it_covers() {
        let mut store = RocksStore::open_in_memory().unwrap();
        let (fifth, sixth) = (next(A, 5, 1), next(A, 6, 1));
        let waiting = store.append(&[fifth.clone(), sixth.clone()]).unwrap();
        assert_eq!(waiting.pending, 2);
        let longer = PatchRow {
            span: 3,
            ..fifth.clone()
        };
        let grown = store.append(std::slice::from_ref(&longer)).unwrap();
        assert_eq!((grown.inserted, grown.pending), (0, 1));
        let first = next(A, 1, 4);
        let filled = store.append(std::slice::from_ref(&first)).unwrap();
        assert_eq!((filled.ready, filled.pending), (2, 0));
        assert_eq!(store.vector("doc").unwrap(), vec![(A, 8)]);
        assert_eq!(store.missing("doc", &vec![]).unwrap(), vec![first, longer]);
        // What it replaced is ignored when it comes again, whatever it holds.
        let changed = PatchRow {
            operations: vec![9],
            ..sixth
        };
        assert_eq!(store.append(&[changed]).unwrap().inserted, 0);
    }

    #[test]
    fn the_first_row_past_a_span_must_build_on_it() {
        let mut store = RocksStore::open_in_memory().unwrap();
        // Waiting rows: the second one says its actor's history ended at 7.
        store
            .append(&[next(A, 6, 1), row(A, 9, 1, &[(A, 7)])])
            .unwrap();
        let error = store.append(&[next(A, 5, 3)]).unwrap_err();
        assert_eq!(
            (error.code, error.message.as_str()),
            ("CONFLICT", "Actor history fork")
        );
        // The refused batch left the waiting rows as they were.
        let again = store.append(&[next(A, 6, 1)]).unwrap();
        assert_eq!((again.inserted, again.pending), (0, 2));
        // A row that builds on the span is accepted, and replaces what it covers.
        let wide = store.append(&[next(A, 5, 2)]).unwrap();
        assert_eq!((wide.inserted, wide.pending), (1, 2));
        let filled = store.append(&[next(A, 1, 4)]).unwrap();
        assert_eq!((filled.ready, filled.pending), (2, 1));
        assert_eq!(store.vector("doc").unwrap(), vec![(A, 7)]);
    }

    #[test]
    fn persists_across_reopen() {
        let path = directory("reopen");
        {
            let mut store = RocksStore::open(&path).unwrap();
            store.append(&[next(A, 1, 3), next(A, 5, 1)]).unwrap();
        }
        let mut store = RocksStore::open(&path).unwrap();
        assert_eq!(store.vector("doc").unwrap(), vec![(A, 4)]);
        assert_eq!(store.missing("doc", &vec![]).unwrap(), vec![next(A, 1, 3)]);
        // A second store cannot open the directory.
        assert_eq!(
            RocksStore::open(&path).err().map(|error| error.code),
            Some("CONNECTION_FAILED")
        );
        assert_eq!(store.append(&[next(A, 4, 1)]).unwrap().ready, 2);
        store.flush().unwrap();
        drop(store);
        let mut store = RocksStore::open(&path).unwrap();
        let (rows, vector) = store.sync_state("doc", &vec![(A, 4)]).unwrap();
        assert_eq!(vector, vec![(A, 6)]);
        assert_eq!(rows, vec![next(A, 4, 1), next(A, 5, 1)]);
        assert!(dump(&store).iter().all(|entry| entry.0 != PENDING));
        drop(store);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn documents_leave_the_cache_and_come_back() {
        let options = RocksOptions {
            cached_documents: 2,
            ..RocksOptions::default()
        };
        let path = directory("cache");
        let mut store = RocksStore::open_with(&path, &options).unwrap();
        let named = |doc_id: &str, mut row: PatchRow| {
            row.doc_id = doc_id.to_owned();
            row
        };
        let ids = ["a", "b", "c", "d", "e"];
        for round in 0..4u64 {
            for doc_id in ids {
                // A gap first, then the row that fills it.
                let clock = 1 + round * 2;
                let gap = store
                    .append(&[named(doc_id, next(A, clock + 1, 1))])
                    .unwrap();
                assert_eq!((gap.ready, gap.pending), (0, 1));
                assert!(store.documents.len() <= 2);
            }
            for doc_id in ids {
                let clock = 1 + round * 2;
                let filled = store.append(&[named(doc_id, next(A, clock, 1))]).unwrap();
                assert_eq!((filled.ready, filled.pending), (2, 0));
                assert_eq!(filled.vector, Some(vec![(A, clock + 2)]));
            }
        }
        assert_eq!(store.documents.len(), 2);
        for doc_id in ids {
            assert_eq!(store.vector(doc_id).unwrap(), vec![(A, 9)]);
            assert_eq!(store.missing(doc_id, &vec![(A, 8)]).unwrap().len(), 1);
        }
        drop(store);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn large_patches_survive_blob_files() {
        let path = directory("blobs");
        let mut store = RocksStore::open(&path).unwrap();
        let rows: Vec<_> = (1..=4u64)
            .map(|clock| {
                let mut row = next(A, clock, 1);
                row.operations = (0..clock as usize * 250_000)
                    .map(|i| (i * 7) as u8)
                    .collect();
                row
            })
            .collect();
        store.append(&rows).unwrap();
        store.flush().unwrap();
        drop(store);
        let mut store = RocksStore::open(&path).unwrap();
        assert_eq!(store.missing("doc", &vec![]).unwrap(), rows);
        assert_eq!(store.append(&rows).unwrap().inserted, 0);
        drop(store);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn the_store_moves_between_threads() {
        fn sendable<T: Send>() {}
        sendable::<RocksStore>();
    }
}
