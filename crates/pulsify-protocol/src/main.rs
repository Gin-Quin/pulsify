use pulsify_protocol::{decode, encode, Body, Message, Relay, MAX_SAFE_INTEGER};
use std::io::{self, BufRead, Write};
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex(value: &str) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0 || value.len() > 16 * 1024 * 1024 {
        return Err("Invalid hex frame".into());
    }
    value
        .as_bytes()
        .chunks(2)
        .map(|chunk| {
            std::str::from_utf8(chunk)
                .map_err(|e| e.to_string())
                .and_then(|s| u8::from_str_radix(s, 16).map_err(|e| e.to_string()))
        })
        .collect()
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mode = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "roundtrip".into());
    if mode == "sample" {
        println!(
            "{}",
            hex(&encode(&Message {
                doc_id: "rust/🌍".into(),
                request_id: 42,
                body: Body::Ack {
                    vv: vec![(65536, 128), (MAX_SAFE_INTEGER, MAX_SAFE_INTEGER)]
                }
            })?)
        );
        return Ok(());
    }
    let mut relay = Relay::default();
    for line in io::stdin().lock().lines() {
        let bytes = unhex(&line?)?;
        let message = decode(&bytes)?;
        let responses = if mode == "relay" {
            relay.receive(message)?
        } else {
            vec![message]
        };
        for response in responses {
            println!("{}", hex(&encode(&response)?));
        }
        io::stdout().flush()?;
    }
    Ok(())
}
