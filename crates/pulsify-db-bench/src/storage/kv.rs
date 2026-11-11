//! One ordered key-value layout for every non-SQL engine.
//!
//! A segment's key is `(sid, end)` in big-endian. One actor's stored segments
//! are contiguous and never overlap (append rejects gaps and overlaps), so
//! ordering by `end` equals ordering by `start`, and both "end > clock" and
//! "the segment starting at X" are forward range scans without a second index.
use super::Transaction;
use crate::model::Segment;
use anyhow::{ensure, Result};
use pulsify_protocol::VersionVector;
use std::collections::BTreeMap;

pub type Key = [u8; 16];
pub fn key(sid: u64, end: u64) -> Key {
    let mut key = [0; 16];
    key[..8].copy_from_slice(&sid.to_be_bytes());
    key[8..].copy_from_slice(&end.to_be_bytes());
    key
}
const MAX: u64 = u64::MAX;

/// Same split as the SQL adapters: JSON metadata next to the raw payload.
pub fn encode(segment: &Segment) -> Result<Vec<u8>> {
    let mut metadata = segment.clone();
    metadata.payload.clear();
    let metadata = serde_json::to_vec(&metadata)?;
    let mut value = Vec::with_capacity(4 + metadata.len() + segment.payload.len());
    value.extend_from_slice(&(metadata.len() as u32).to_be_bytes());
    value.extend_from_slice(&metadata);
    value.extend_from_slice(&segment.payload);
    Ok(value)
}
pub fn decode(value: &[u8]) -> Result<Segment> {
    ensure!(value.len() >= 4, "truncated segment");
    let length = u32::from_be_bytes(value[..4].try_into()?) as usize;
    ensure!(value.len() >= 4 + length, "truncated segment metadata");
    let mut segment: Segment = serde_json::from_slice(&value[4..4 + length])?;
    segment.payload = value[4 + length..].to_vec();
    Ok(segment)
}

/// Receives each scanned entry: its 16-byte key and its value.
pub type Visit<'a> = dyn FnMut(&[u8], &[u8]) -> Result<()> + 'a;

/// One document inside one engine transaction. Scans see the transaction's own writes
/// unless the engine documents otherwise.
pub trait Kv {
    fn vector(&mut self) -> Result<Option<Vec<u8>>>;
    fn set_vector(&mut self, value: &[u8]) -> Result<()>;
    /// Visit at most `limit` entries of `[from, to)` in key order.
    fn scan(&mut self, from: Key, to: Key, limit: usize, visit: &mut Visit<'_>) -> Result<()>;
    fn put(&mut self, key: Key, value: &[u8]) -> Result<()>;
    fn delete(&mut self, key: Key) -> Result<()>;
    /// Called first in a read. An engine with a server-side consistent read returns
    /// the segments itself; one without snapshots pins its frontier here.
    fn read(&mut self, _remote: &VersionVector) -> Result<Option<Vec<Segment>>> {
        Ok(None)
    }
}

pub struct Tx<K>(pub K);
impl<K: Kv> Tx<K> {
    fn collect(&mut self, from: Key, to: Key, limit: usize) -> Result<Vec<Segment>> {
        let mut segments = Vec::new();
        self.0.scan(from, to, limit, &mut |_, value| {
            segments.push(decode(value)?);
            Ok(())
        })?;
        Ok(segments)
    }
}
impl<K: Kv> Transaction for Tx<K> {
    fn vector(&mut self) -> Result<VersionVector> {
        Ok(self
            .0
            .vector()?
            .map(|v| serde_json::from_slice(&v))
            .transpose()?
            .unwrap_or_default())
    }
    fn set_vector(&mut self, vv: &VersionVector) -> Result<()> {
        self.0.set_vector(&serde_json::to_vec(vv)?)
    }
    fn get(&mut self, sid: u64, start: u64) -> Result<Option<Segment>> {
        // If a segment starts here, it is the first one ending after this clock.
        let found = self.collect(key(sid, start + 1), key(sid, MAX), 1)?;
        Ok(found.into_iter().next().filter(|s| s.start == start))
    }
    fn read(&mut self, remote: &VersionVector) -> Result<Vec<Segment>> {
        if let Some(segments) = self.0.read(remote)? {
            return Ok(segments);
        }
        if remote.is_empty() {
            return self.collect(key(0, 0), key(MAX, MAX), usize::MAX);
        }
        // Everything of the actors the reader never saw, and each known actor's
        // unseen suffix: two ranges per remote entry, whatever the stored actor count.
        let mut remote = remote.clone();
        remote.sort_unstable();
        let mut segments = Vec::new();
        let mut from = key(0, 0);
        for (sid, clock) in remote {
            if from < key(sid, 0) {
                segments.extend(self.collect(from, key(sid, 0), usize::MAX)?);
            }
            segments.extend(self.collect(key(sid, clock + 1), key(sid, MAX), usize::MAX)?);
            if sid == MAX {
                return Ok(segments);
            }
            from = key(sid + 1, 0);
        }
        segments.extend(self.collect(from, key(MAX, MAX), usize::MAX)?);
        Ok(segments)
    }
    fn put(&mut self, segment: &Segment) -> Result<()> {
        self.0.put(key(segment.sid, segment.end), &encode(segment)?)
    }
    fn matches(&mut self, sources: &[Segment]) -> Result<bool> {
        let (first, last) = (&sources[0], sources.last().unwrap());
        let actual = self.collect(
            key(first.sid, first.end),
            key(first.sid, last.end + 1),
            usize::MAX,
        )?;
        Ok(actual == sources)
    }
    fn remove(&mut self, sources: &[Segment]) -> Result<()> {
        let (first, last) = (&sources[0], sources.last().unwrap());
        let mut keys = Vec::new();
        self.0.scan(
            key(first.sid, first.end),
            key(first.sid, last.end + 1),
            usize::MAX,
            &mut |k, _| {
                keys.push(Key::try_from(k)?);
                Ok(())
            },
        )?;
        ensure!(keys.len() == sources.len(), "compaction delete count");
        for key in keys {
            self.0.delete(key)?;
        }
        Ok(())
    }
}

/// `s` + doc + NUL + key for segments, `v` + doc for the frontier: a document's
/// segments are one contiguous key range, and so is every cleanup prefix.
pub fn segment_prefix(doc: &str) -> Vec<u8> {
    [b"s", doc.as_bytes(), &[0]].concat()
}
pub fn vector_key(doc: &str) -> Vec<u8> {
    [b"v", doc.as_bytes()].concat()
}
/// Byte ranges covering every document whose name starts with `prefix`.
pub fn cleanup_ranges(prefix: &str) -> [(Vec<u8>, Vec<u8>); 2] {
    [b's', b'v'].map(|space| {
        (
            [&[space], prefix.as_bytes()].concat(),
            [&[space], prefix.as_bytes(), b"~"].concat(),
        )
    })
}

/// Writes of one transaction for engines that apply them in a single request:
/// per key, whether to remove what is stored, then the value to store.
#[derive(Default)]
pub struct Buffer {
    pub pending: BTreeMap<Key, (bool, Option<Vec<u8>>)>,
    pub vector: Option<Vec<u8>>,
}
impl Buffer {
    pub fn is_empty(&self) -> bool {
        self.pending.is_empty() && self.vector.is_none()
    }
    pub fn put(&mut self, key: Key, value: &[u8]) {
        let replace = self.pending.get(&key).is_some_and(|entry| entry.0);
        self.pending.insert(key, (replace, Some(value.to_vec())));
    }
    pub fn delete(&mut self, key: Key) {
        self.pending.insert(key, (true, None));
    }
    /// Stored entries of `[from, to)` as this transaction sees them.
    pub fn overlay(
        &self,
        stored: impl IntoIterator<Item = (Key, Vec<u8>)>,
        from: Key,
        to: Key,
        limit: usize,
        visit: &mut Visit<'_>,
    ) -> Result<()> {
        let mut entries: BTreeMap<Key, Vec<u8>> = stored.into_iter().collect();
        if from < to {
            for (key, (_, value)) in self.pending.range(from..to) {
                match value {
                    Some(value) => entries.insert(*key, value.clone()),
                    None => entries.remove(key),
                };
            }
        }
        for (key, value) in entries.iter().take(limit) {
            visit(key, value)?;
        }
        Ok(())
    }
}

/// Document lock for engines without a lock manager: writers of one document
/// share a stripe. A stripe can also hold unrelated documents, as in RocksDB's own
/// lock table.
pub struct Locks(Vec<std::sync::Mutex<()>>);
impl Default for Locks {
    fn default() -> Self {
        Self((0..256).map(|_| std::sync::Mutex::new(())).collect())
    }
}
impl Locks {
    pub fn lock(&self, doc: &str) -> std::sync::MutexGuard<'_, ()> {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        doc.hash(&mut hasher);
        let stripe = &self.0[hasher.finish() as usize % self.0.len()];
        stripe
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
