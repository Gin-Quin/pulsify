//! Durable Pulsify documents in SQLite, without materializing them.
//!
//! The database file uses the schema and append semantics of the TypeScript
//! `SqlitePatchStore`, so either implementation can open a file written by the other.
mod hub;
mod relay;
mod store;

pub use pulsify_protocol::{
    chunk_rows, relay_frame, AppendResult, PatchRow, PatchStore, RelayOutput, Sink, VersionVector,
};
pub use store::{validate_doc_id, SqliteStore, PACKED_MIGRATION, SCHEMA};

/// One writer and its sessions: each session is pinned to a document, and rows
/// stored through one session are forwarded to the document's other sessions.
pub type Hub<S> = pulsify_protocol::Hub<SqliteStore, S>;

use std::fmt;

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
impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Self::new("CONNECTION_FAILED", format!("SQLite: {error}"))
    }
}
impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self::new(
            "CONNECTION_FAILED",
            format!("Corrupt stored metadata: {error}"),
        )
    }
}
pub type Result<T> = std::result::Result<T, Error>;
