//! Valkey and Dragonfly through the Redis protocol.
//!
//! One sorted set per document holds `key ‖ value` members with equal scores, so
//! lexicographic ranges are the ordered key-value scans of `kv.rs`. Writers take a
//! server-side document lock: a one-token list they block on with BLPOP. Their
//! writes and the lock release travel in one MULTI/EXEC. Readers run one script,
//! which the server executes atomically, so they never see half a transaction.
use super::kv::{self, Key, Kv};
use super::{Output, Session, Work};
use crate::model::Segment;
use anyhow::{ensure, Result};
use pulsify_protocol::VersionVector;
use redis::{Connection, Script};

const INIT: &str =
    "if redis.call('SET', KEYS[1], 1, 'NX') then redis.call('RPUSH', KEYS[2], 1) end return 1";
// ARGV holds (sid, first unseen key) pairs. Actor IDs stay opaque 8-byte strings:
// Lua numbers cannot hold a u64.
const READ: &str = r"
local out = {redis.call('GET', KEYS[2])}
if #ARGV == 0 then
  for _, member in ipairs(redis.call('ZRANGEBYLEX', KEYS[1], '-', '+')) do out[#out + 1] = member end
  return out
end
local from = {}
for i = 1, #ARGV, 2 do from[ARGV[i]] = ARGV[i + 1] end
local cursor = '-'
while true do
  local first = redis.call('ZRANGEBYLEX', KEYS[1], cursor, '+', 'LIMIT', 0, 1)
  if #first == 0 then break end
  local sid = string.sub(first[1], 1, 8)
  local last = '(' .. sid .. '\255\255\255\255\255\255\255\255'
  for _, member in ipairs(redis.call('ZRANGEBYLEX', KEYS[1], '[' .. (from[sid] or sid), last)) do
    out[#out + 1] = member
  end
  cursor = last
end
return out";

pub struct Resp(Connection, Script);
impl Resp {
    pub fn open(url: &str) -> Result<Self> {
        Ok(Self(
            redis::Client::open(url)?.get_connection()?,
            Script::new(READ),
        ))
    }
    /// Server identity and the persistence settings it reports for itself.
    pub fn metadata(&mut self, backend: &str, relaxed: bool) -> Result<serde_json::Value> {
        let info: String = redis::cmd("INFO").query(&mut self.0)?;
        let field = |name: &str| {
            info.lines()
                .find_map(|line| line.strip_prefix(name)?.strip_prefix(':'))
                .map(str::to_owned)
        };
        let mut settings = serde_json::Map::new();
        for name in ["appendonly", "appendfsync", "save", "aof"] {
            // Each server only knows its own names; the others stay null.
            let value = redis::cmd("CONFIG")
                .arg("GET")
                .arg(name)
                .query::<Vec<String>>(&mut self.0)
                .ok()
                .and_then(|pair| pair.get(1).cloned());
            settings.insert(name.into(), value.into());
        }
        if backend == "valkey" {
            ensure!(
                settings["appendonly"] == "yes"
                    && settings["appendfsync"] == if relaxed { "everysec" } else { "always" },
                "Valkey append-only settings do not match the durability tier"
            );
        } else {
            ensure!(
                relaxed,
                "Dragonfly cannot flush before replying; it belongs to the relaxed tier"
            );
        }
        Ok(serde_json::json!({
            "version": field("valkey_version").or(field("dragonfly_version")).or(field("redis_version")),
            "settings": settings,
            "inMemory": true,
        }))
    }
}

fn name(space: &str, doc: &str) -> String {
    format!("{space}:{doc}")
}
fn bound(mark: u8, key: &[u8]) -> Vec<u8> {
    [&[mark], key].concat()
}
/// Every member whose 16-byte key is exactly `key`: values start with a zero byte.
fn exact(key: Key) -> (Vec<u8>, Vec<u8>) {
    (bound(b'[', &key), bound(b'(', &[&key[..], &[1]].concat()))
}

struct Tx<'a> {
    connection: &'a mut Connection,
    script: &'a Script,
    doc: &'a str,
    buffer: kv::Buffer,
    /// A read-only transaction's frontier, fetched by the same script as its segments.
    snapshot: Option<Option<Vec<u8>>>,
}
impl Kv for Tx<'_> {
    fn vector(&mut self) -> Result<Option<Vec<u8>>> {
        if let Some(vector) = &self.snapshot {
            return Ok(vector.clone());
        }
        Ok(redis::cmd("GET")
            .arg(name("v", self.doc))
            .query(self.connection)?)
    }
    fn set_vector(&mut self, value: &[u8]) -> Result<()> {
        self.buffer.vector = Some(value.to_vec());
        Ok(())
    }
    fn scan(&mut self, from: Key, to: Key, limit: usize, visit: &mut kv::Visit<'_>) -> Result<()> {
        let mut command = redis::cmd("ZRANGEBYLEX");
        command
            .arg(name("s", self.doc))
            .arg(bound(b'[', &from))
            .arg(bound(b'(', &to));
        // Buffered writes can hide or add entries, so only an empty buffer may limit.
        if self.buffer.pending.is_empty() && limit != usize::MAX {
            command.arg("LIMIT").arg(0).arg(limit);
        }
        let stored: Vec<Vec<u8>> = command.query(self.connection)?;
        let mut entries = Vec::with_capacity(stored.len());
        for member in stored {
            ensure!(member.len() > 16, "truncated member");
            entries.push((Key::try_from(&member[..16])?, member[16..].to_vec()));
        }
        self.buffer.overlay(entries, from, to, limit, visit)
    }
    fn put(&mut self, key: Key, value: &[u8]) -> Result<()> {
        self.buffer.put(key, value);
        Ok(())
    }
    fn delete(&mut self, key: Key) -> Result<()> {
        self.buffer.delete(key);
        Ok(())
    }
    fn read(&mut self, remote: &VersionVector) -> Result<Option<Vec<Segment>>> {
        let mut call = self.script.prepare_invoke();
        call.key(name("s", self.doc)).key(name("v", self.doc));
        for (sid, clock) in remote {
            call.arg(&sid.to_be_bytes()[..])
                .arg(&kv::key(*sid, clock + 1)[..]);
        }
        let mut reply: Vec<Option<Vec<u8>>> = call.invoke(self.connection)?;
        ensure!(!reply.is_empty(), "empty read reply");
        self.snapshot = Some(reply.remove(0));
        reply
            .iter()
            .map(|member| {
                let member = member.as_deref().unwrap_or_default();
                ensure!(member.len() > 16, "truncated member");
                kv::decode(&member[16..])
            })
            .collect::<Result<Vec<_>>>()
            .map(Some)
    }
}
impl Session for Resp {
    fn cleanup(&mut self, prefix: &str) -> Result<()> {
        let mut cursor = 0u64;
        loop {
            let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg(format!("?:{prefix}*"))
                .arg("COUNT")
                .arg(1000)
                .query(&mut self.0)?;
            if !keys.is_empty() {
                redis::cmd("DEL").arg(keys).query::<()>(&mut self.0)?;
            }
            if next == 0 {
                return Ok(());
            }
            cursor = next;
        }
    }
    fn transact(&mut self, doc: &str, write: bool, work: &mut Work<'_>) -> Result<Output> {
        let lock = name("l", doc);
        if write {
            let (_, token): (i64, Option<(String, String)>) = redis::pipe()
                .cmd("EVAL")
                .arg(INIT)
                .arg(2)
                .arg(name("i", doc))
                .arg(&lock)
                .cmd("BLPOP")
                .arg(&lock)
                .arg(30)
                .query(&mut self.0)?;
            ensure!(token.is_some(), "document lock timeout");
        }
        let mut tx = kv::Tx(Tx {
            connection: &mut self.0,
            script: &self.1,
            doc,
            buffer: kv::Buffer::default(),
            snapshot: None,
        });
        let result = work(&mut tx);
        if !write {
            return result;
        }
        let kv::Buffer { pending, vector } = tx.0.buffer;
        let mut commit = redis::pipe();
        commit.atomic();
        if result.is_ok() {
            let segments = name("s", doc);
            for (key, (replace, value)) in pending {
                if replace {
                    let (from, to) = exact(key);
                    commit
                        .cmd("ZREMRANGEBYLEX")
                        .arg(&segments)
                        .arg(from)
                        .arg(to)
                        .ignore();
                }
                if let Some(value) = value {
                    commit
                        .cmd("ZADD")
                        .arg(&segments)
                        .arg(0)
                        .arg([&key[..], &value].concat())
                        .ignore();
                }
            }
            if let Some(vector) = vector {
                commit.cmd("SET").arg(name("v", doc)).arg(vector).ignore();
            }
        }
        // Release in the same EXEC as the writes; a failed transaction only releases.
        commit.cmd("RPUSH").arg(&lock).arg(1).ignore();
        commit.query::<()>(&mut self.0)?;
        result
    }
}
