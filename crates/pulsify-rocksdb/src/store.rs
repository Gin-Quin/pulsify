use crate::{Error, Result};
use pulsify_protocol::{
    validate_rows, validate_vector, AppendResult, PatchRow, PatchStore, VersionVector,
    MAX_VECTOR_ENTRIES,
};
use rocksdb::{
    BlockBasedOptions, Cache, ColumnFamily, ColumnFamilyDescriptor, DBCompressionType,
    DBRawIterator, Env, LogLevel, Options, ReadOptions, SliceTransform, WriteBatch, WriteOptions,
    DB,
};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

// Column families. Every key starts with the document ID and a NUL, which an
// ID cannot contain, so a document is one contiguous key range in each of
// them; integers are big-endian, so keys sort by `(doc_id, sid, clock)`.
/// `doc_id NUL sid clock` to a row: format byte, span, dependencies, operations.
const ROWS: &str = "rows";
/// `doc_id NUL sid` to the actor's committed clock.
const CLOCKS: &str = "clocks";
/// `doc_id NUL sid clock` to the span and dependencies of a row that is not
/// ready yet: what promotion needs, without reading the rows.
const PENDING: &str = "pending";

/// First byte of a stored row. Other values are free for later formats, such
/// as a packed segment of several rows.
const FORMAT_ROW: u8 = 0;
/// Values from this size live in blob files (as in the storage benchmark).
const MIN_BLOB_BYTES: u64 = 4096;

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
            // rewritten at each level. Rows are never deleted or replaced, so
            // blob garbage collection stays off.
            options.set_enable_blob_files(true);
            options.set_min_blob_size(MIN_BLOB_BYTES);
            options.set_blob_compression_type(DBCompressionType::Lz4);
        }
        None => {
            // Clocks are overwritten by every append and pending entries are
            // short-lived: a small buffer drops the obsolete versions when it
            // is flushed, and the files stay tiny.
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

/// Immutable rows keyed by `(doc_id, sid, clock)`. Rows stay pending until
/// their actor prefix is contiguous and their dependencies are stored.
///
/// A store owns its database: RocksDB locks the directory, so no other
/// process (or second `RocksStore`) can open it. Writes go through `&mut
/// self`, one at a time, each as one atomic write batch; reads take `&self`
/// and can run from several threads between writes. Wrap the store in a
/// `Mutex` (or use a [`Hub`](crate::Hub)) to share it.
pub struct RocksStore {
    db: DB,
    sync: bool,
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
        let families = [
            ColumnFamilyDescriptor::new(ROWS, family_options(&cache, Some(options))),
            ColumnFamilyDescriptor::new(CLOCKS, family_options(&cache, None)),
            ColumnFamilyDescriptor::new(PENDING, family_options(&cache, None)),
        ];
        Ok(Self {
            db: DB::open_cf_descriptors(&database, path, families)?,
            sync: options.sync,
            documents: HashMap::new(),
            capacity: options.cached_documents,
            tick: 0,
        })
    }
    /// The underlying database, to inspect or back up. Writing to it would
    /// break the store.
    pub fn db(&self) -> &DB {
        &self.db
    }
    /// Writes the in-memory buffers to files. Appends are durable without it.
    pub fn flush(&self) -> Result<()> {
        for name in [ROWS, CLOCKS, PENDING] {
            self.db.flush_cf(self.family(name)?)?;
        }
        Ok(())
    }

    /// Validates and stores rows of one document in one atomic write batch.
    /// Exact retransmissions are ignored; a conflict writes nothing.
    pub fn append(&mut self, rows: &[PatchRow]) -> Result<AppendResult> {
        let Some(doc_id) = validate_rows(rows)? else {
            return Ok(AppendResult::default());
        };
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

    fn append_rows(
        &self,
        prefix: &[u8],
        document: &mut Document,
        rows: &[PatchRow],
    ) -> Result<AppendResult> {
        let stored_rows = self.family(ROWS)?;
        let Document {
            frontier, pending, ..
        } = document;
        let mut batch = WriteBatch::default();
        // The rows this batch stores, which the database does not show yet.
        let mut added: BTreeMap<(u64, u64), &PatchRow> = BTreeMap::new();
        let mut cursor = None;
        let mut pending_actors: BTreeSet<u64> = pending.iter().map(|row| row.sid).collect();
        let mut changed_actors = BTreeSet::new();
        let (mut inserted, mut ready) = (0, 0);
        for row in rows {
            let key = row_key(prefix, row.sid, row.clock);
            // A row that is ready on arrival (the common, in-order case) never
            // enters the pending column family.
            let ready_now = row.clock == frontier.get(&row.sid).copied().unwrap_or(1)
                && row
                    .dependencies
                    .iter()
                    .all(|(actor, clock)| frontier.get(actor).copied().unwrap_or(0) >= *clock);
            if ready_now && !pending_actors.contains(&row.sid) {
                // Ready rows of an actor tile [1, frontier) and it has no pending
                // row, so no stored row starts at or after this one: it is neither
                // a duplicate nor overlapping, and the previous row ends exactly at
                // the frontier. Only the fork check remains, without reading it.
                if row.clock > 1 && own_clock(&row.dependencies, row.sid) < row.clock {
                    return Err(conflict("Actor history fork"));
                }
            } else {
                if let Some(existing) = added.get(&(row.sid, row.clock)) {
                    if !same_row(existing, row) {
                        return Err(conflict("Conflicting storage segment"));
                    }
                    continue;
                }
                if cursor.is_none() {
                    cursor = Some(self.cursor(ROWS, prefix)?);
                }
                let cursor = cursor.as_mut().expect("created above");
                // The first stored row at or after this one, then the last before it.
                let mut neighbours = [None, None];
                cursor.seek(&key);
                if let Some((found, value)) = cursor.item() {
                    if found == key.as_slice() {
                        let (span, dependencies, operations) = header(value)?;
                        if span != row.span
                            || dependencies != row.dependencies
                            || operations != row.operations.as_slice()
                        {
                            return Err(conflict("Conflicting storage segment"));
                        }
                        continue;
                    }
                    neighbours[1] = segment(found, value, prefix, row.sid)?;
                }
                cursor.status()?;
                cursor.seek_for_prev(&key);
                if let Some((found, value)) = cursor.item() {
                    neighbours[0] = segment(found, value, prefix, row.sid)?;
                }
                cursor.status()?;
                let position = (row.sid, row.clock);
                let before = added.range(..position).next_back();
                let after = added.range(position..).next();
                for (slot, other) in [before, after].into_iter().enumerate() {
                    let Some(other) = other.filter(|other| other.0 .0 == row.sid) else {
                        continue;
                    };
                    let nearer = neighbours[slot]
                        .as_ref()
                        .is_none_or(|stored| (other.1.clock > stored.clock) == (slot == 0));
                    if nearer {
                        neighbours[slot] = Some(Segment {
                            clock: other.1.clock,
                            span: other.1.span,
                            dependencies: other.1.dependencies.clone(),
                        });
                    }
                }
                for other in neighbours.iter().flatten() {
                    assert_compatible(row, other)?;
                }
            }
            batch.put_cf(stored_rows, &key, encode(row));
            added.insert((row.sid, row.clock), row);
            inserted += 1;
            if ready_now {
                frontier.insert(row.sid, row.clock + row.span);
                changed_actors.insert(row.sid);
                ready += 1;
            } else {
                pending.push(Pending {
                    sid: row.sid,
                    start: row.clock,
                    end: row.clock + row.span,
                    dependencies: row.dependencies.clone(),
                    stored: false,
                });
                pending_actors.insert(row.sid);
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
        // one only moves the clock: the row itself is not rewritten.
        let waiting = self.family(PENDING)?;
        pending.sort_by_key(|row| (row.sid, row.start));
        loop {
            let before = pending.len();
            pending.retain(|row| {
                let contiguous = row.start == frontier.get(&row.sid).copied().unwrap_or(1);
                let covered = row
                    .dependencies
                    .iter()
                    .all(|(actor, clock)| frontier.get(actor).copied().unwrap_or(0) >= *clock);
                if !contiguous || !covered {
                    return true;
                }
                if row.stored {
                    batch.delete_cf(waiting, row_key(prefix, row.sid, row.start));
                }
                let clock = frontier.entry(row.sid).or_insert(0);
                *clock = (*clock).max(row.end);
                changed_actors.insert(row.sid);
                ready += 1;
                false
            });
            if pending.len() == before {
                break;
            }
        }
        for row in pending.iter_mut().filter(|row| !row.stored) {
            let mut value = Vec::new();
            encode_header(&mut value, row.end - row.start, &row.dependencies);
            batch.put_cf(waiting, row_key(prefix, row.sid, row.start), value);
            row.stored = true;
        }
        let clocks = self.family(CLOCKS)?;
        for sid in changed_actors {
            let mut key = prefix.to_vec();
            key.extend_from_slice(&sid.to_be_bytes());
            batch.put_cf(clocks, key, frontier[&sid].to_be_bytes());
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

    fn read_missing(
        &self,
        doc_id: &str,
        prefix: &[u8],
        frontier: &BTreeMap<u64, u64>,
        remote: &VersionVector,
    ) -> Result<Vec<PatchRow>> {
        let mut rows = Vec::new();
        let mut cursor = self.cursor(ROWS, prefix)?;
        let mut push = |key: &[u8], value: &[u8], since: u64| -> Result<()> {
            let (sid, clock) = row_key_of(key, prefix).ok_or_else(corrupt)?;
            let (span, dependencies, operations) = header(value)?;
            // Rows from the actor's clock on are pending.
            if clock < frontier.get(&sid).copied().unwrap_or(0) && clock + span > since {
                rows.push(PatchRow {
                    doc_id: doc_id.to_owned(),
                    sid,
                    clock,
                    span,
                    dependencies,
                    operations: operations.to_vec(),
                });
            }
            Ok(())
        };
        if remote.is_empty() {
            // The whole document is one run of consecutive keys.
            cursor.seek(prefix);
            while let Some((key, value)) = cursor.item() {
                push(key, value, 0)?;
                cursor.next();
            }
            cursor.status()?;
            return Ok(rows);
        }
        // One seek per actor that is behind, then its rows in order.
        for (sid, clock) in frontier {
            let since = own_clock(remote, *sid);
            if *clock <= since {
                continue;
            }
            let from = row_key(prefix, *sid, since);
            let actor = &from[..from.len() - 8];
            // The row holding `since` may start before it.
            cursor.seek_for_prev(&from);
            if cursor.key().is_some_and(|key| key.starts_with(actor)) {
                // Stay on it: the loop below reads it first.
            } else {
                cursor.status()?;
                cursor.seek(&from);
            }
            let end = row_key(prefix, *sid, *clock);
            while let Some((key, value)) = cursor.item() {
                if key >= end.as_slice() {
                    break;
                }
                push(key, value, since)?;
                cursor.next();
            }
            cursor.status()?;
        }
        Ok(rows)
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
fn same_row(stored: &PatchRow, row: &PatchRow) -> bool {
    stored.span == row.span
        && stored.dependencies == row.dependencies
        && stored.operations == row.operations
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
fn encode(row: &PatchRow) -> Vec<u8> {
    let mut value = Vec::with_capacity(row.operations.len() + 8 + row.dependencies.len() * 12);
    encode_header(&mut value, row.span, &row.dependencies);
    value.extend_from_slice(&row.operations);
    value
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

/// The stored envelope of a neighbouring segment of the same actor.
struct Segment {
    clock: u64,
    span: u64,
    dependencies: VersionVector,
}
/// The segment at a key, when it belongs to `sid`.
fn segment(key: &[u8], value: &[u8], prefix: &[u8], sid: u64) -> Result<Option<Segment>> {
    let (actor, clock) = row_key_of(key, prefix).ok_or_else(corrupt)?;
    if actor != sid {
        return Ok(None);
    }
    let (span, dependencies, _) = header(value)?;
    Ok(Some(Segment {
        clock,
        span,
        dependencies,
    }))
}

fn assert_compatible(row: &PatchRow, other: &Segment) -> Result<()> {
    if row.clock < other.clock + other.span && other.clock < row.clock + row.span {
        return Err(conflict("Overlapping immutable storage segments"));
    }
    let (previous_end, next_dependency) = if row.clock < other.clock {
        (
            row.clock + row.span,
            own_clock(&other.dependencies, row.sid),
        )
    } else {
        (
            other.clock + other.span,
            own_clock(&row.dependencies, row.sid),
        )
    };
    if next_dependency < previous_end {
        return Err(conflict("Actor history fork"));
    }
    Ok(())
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
    /// Every key and value of the three column families.
    fn dump(store: &RocksStore) -> Vec<(&'static str, Vec<u8>, Vec<u8>)> {
        let mut entries = Vec::new();
        for name in [ROWS, CLOCKS, PENDING] {
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
                vec![next(A, 3, 1), next(B, 1, 2), next(A, 4, 2), next(A, 5, 1)],
                vec![next(A, 3, 1), next(B, 1, 2), row(A, 4, 1, &[(A, 3)])],
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
