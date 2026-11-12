use anyhow::{ensure, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
use pulsify_protocol::{decode, encode, Body, Message, PatchRow, VersionVector};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Segment {
    pub sid: u64,
    pub start: u64,
    pub end: u64,
    pub dependencies: VersionVector,
    pub compressed: bool,
    pub hash: Vec<u8>,
    pub payload: Vec<u8>,
}
impl Segment {
    pub fn pack(rows: Vec<PatchRow>, compressed: bool) -> Result<Self> {
        let first = rows
            .first()
            .ok_or_else(|| anyhow::anyhow!("empty segment"))?;
        let mut end = first.clock;
        for row in &rows {
            ensure!(
                row.sid == first.sid && row.doc_id == first.doc_id && row.clock == end,
                "noncontiguous segment"
            );
            end = row.end();
        }
        let mut segment = Self {
            sid: first.sid,
            start: first.clock,
            end,
            dependencies: first.dependencies.clone(),
            compressed,
            hash: vec![],
            payload: vec![],
        };
        let bytes = encode(&Message {
            doc_id: first.doc_id.clone(),
            request_id: 0,
            body: Body::Update { vv: vec![], rows },
        })?;
        segment.payload = if compressed {
            let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(6));
            encoder.write_all(&bytes)?;
            encoder.finish()?
        } else {
            bytes
        };
        segment.hash = Sha256::digest(&segment.payload).to_vec();
        Ok(segment)
    }
    pub fn unpack(&self) -> Result<Vec<PatchRow>> {
        ensure!(
            Sha256::digest(&self.payload).as_slice() == self.hash,
            "segment checksum mismatch"
        );
        let mut decoded = Vec::new();
        let bytes = if self.compressed {
            ZlibDecoder::new(&self.payload[..])
                .take((pulsify_protocol::MAX_FRAME_BYTES + 1) as u64)
                .read_to_end(&mut decoded)?;
            ensure!(
                decoded.len() <= pulsify_protocol::MAX_FRAME_BYTES,
                "inflation limit"
            );
            &decoded
        } else {
            &self.payload
        };
        match decode(bytes)?.body {
            Body::Update { rows, .. } => Ok(rows),
            _ => anyhow::bail!("not an update"),
        }
    }
}
pub fn frame_rows(frame: &str) -> Result<Vec<PatchRow>> {
    match decode(&STANDARD.decode(frame)?)?.body {
        Body::Update { rows, .. } => Ok(rows),
        _ => anyhow::bail!("not an update"),
    }
}
pub fn frame(rows: Vec<PatchRow>) -> Result<String> {
    let doc_id = rows
        .first()
        .ok_or_else(|| anyhow::anyhow!("empty frame"))?
        .doc_id
        .clone();
    Ok(STANDARD.encode(encode(&Message {
        doc_id,
        request_id: 0,
        body: Body::Update { vv: vec![], rows },
    })?))
}

#[derive(Deserialize)]
pub struct Fixture {
    pub profile: String,
    /// The whole history, in frames of bounded row count.
    pub seed: Vec<String>,
    pub initial: String,
    pub remote: VersionVector,
    pub streams: Vec<Vec<String>>,
}
pub struct Prepared {
    pub profile: String,
    pub seed: Vec<Segment>,
    pub seed_rows: Vec<PatchRow>,
    pub initial: Vec<Segment>,
    pub remote: VersionVector,
    pub streams: Vec<Vec<Segment>>,
}
impl Prepared {
    pub fn new(f: Fixture) -> Result<Self> {
        let seed_rows: Vec<PatchRow> = f
            .seed
            .iter()
            .map(|frame| frame_rows(frame))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect();
        let pack = |rows: Vec<PatchRow>| {
            rows.into_iter()
                .map(|r| Segment::pack(vec![r], false))
                .collect::<Result<Vec<_>>>()
        };
        let streams = f
            .streams
            .iter()
            .map(|s| {
                s.iter()
                    .map(|frame| {
                        let rows = frame_rows(frame)?;
                        ensure!(rows.len() == 1, "one actual patch per request");
                        Segment::pack(rows, false)
                    })
                    .collect()
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            profile: f.profile,
            seed: pack(seed_rows.clone())?,
            seed_rows,
            initial: pack(frame_rows(&f.initial)?)?,
            remote: f.remote,
            streams,
        })
    }
}
