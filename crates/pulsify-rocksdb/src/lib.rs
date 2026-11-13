//! Durable Pulsify documents in RocksDB, without materializing them.
//!
//! [`RocksStore`] has the append semantics of `pulsify-sqlite`'s `SqliteStore`
//! and of the TypeScript `SqlitePatchStore`: the same rows are accepted,
//! rejected, kept pending and returned, with the same errors.
mod store;

pub use pulsify_protocol::{
    chunk_rows, relay_frame, AppendResult, PatchRow, PatchStore, RelayOutput, Sink, VersionVector,
};
pub use store::{validate_doc_id, RocksOptions, RocksStore};

use std::fmt;

/// One writer and its sessions: each session is pinned to a document, and rows
/// stored through one session are forwarded to the document's other sessions.
pub type Hub<S> = pulsify_protocol::Hub<RocksStore, S>;

/// A failure carrying a Pulsify protocol error code, such as `CONFLICT`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}
impl Error {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for Error {}
impl From<pulsify_protocol::Error> for Error {
    fn from(error: pulsify_protocol::Error) -> Self {
        Self::new(error.code, error.message)
    }
}
impl From<Error> for pulsify_protocol::Error {
    fn from(error: Error) -> Self {
        Self::new(error.code, error.message)
    }
}
impl From<rocksdb::Error> for Error {
    fn from(error: rocksdb::Error) -> Self {
        Self::new("CONNECTION_FAILED", format!("RocksDB: {error}"))
    }
}
pub type Result<T> = std::result::Result<T, Error>;
