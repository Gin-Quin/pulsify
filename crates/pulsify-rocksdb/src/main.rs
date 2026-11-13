//! Test harness speaking JSON lines over stdin/stdout, mirroring the Tauri plugin commands:
//! `[id,"open",docId]`, `[id,"send",session,hex]`, `[id,"close",session]`.
//! Frames are written as `{"frame":session,"hex":…}`, replies as `{"id":…,"ok":…}` or `{"id":…,"error":…}`.
use pulsify_rocksdb::{Error, Hub, RocksStore};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex(value: &str) -> Option<Vec<u8>> {
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(value.get(i..i + 2)?, 16).ok())
        .collect()
}
fn emit(value: Value) {
    let mut stdout = io::stdout().lock();
    let _ = writeln!(stdout, "{value}");
    let _ = stdout.flush();
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: pulsify-rocksdb <database-directory>")?;
    let mut hub = Hub::new(RocksStore::open(path)?);
    let sink = |session: u64, frame: Vec<u8>| {
        emit(json!({ "frame": session, "hex": hex(&frame) }));
        true
    };
    let invalid = || Error::new("INVALID_MESSAGE", "Malformed harness command");
    for line in io::stdin().lock().lines() {
        let command: Value = serde_json::from_str(&line?)?;
        let id = command[0].clone();
        let result = match command[1].as_str() {
            Some("open") => command[2]
                .as_str()
                .ok_or_else(invalid)
                .and_then(|doc_id| hub.open(doc_id, "harness", sink))
                .map(Value::from),
            Some("send") => command[2]
                .as_u64()
                .zip(command[3].as_str().and_then(unhex))
                .ok_or_else(invalid)
                .and_then(|(session, bytes)| hub.send(session, &bytes))
                .map(|()| Value::Null),
            Some("close") => command[2]
                .as_u64()
                .ok_or_else(invalid)
                .map(|session| Value::from(hub.close(session))),
            _ => Err(invalid()),
        };
        emit(match result {
            Ok(value) => json!({ "id": id, "ok": value }),
            Err(error) => {
                json!({ "id": id, "error": { "code": error.code, "message": error.message } })
            }
        });
    }
    Ok(())
}
