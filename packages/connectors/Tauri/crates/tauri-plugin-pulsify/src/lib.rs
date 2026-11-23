//! Tauri 2 plugin persisting Pulsify documents in a local SQLite database.
//!
//! Register it with `.plugin(tauri_plugin_pulsify::init())` and connect documents
//! with `createTauriConnector()` from `pulsify-tauri`.
use pulsify_sqlite::{DocumentStore, Hub, SqliteStore};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent, Runtime, State, Webview, WindowEvent};

pub use pulsify_sqlite;

/// Header carrying the session ID of a raw `send` invocation.
pub const SESSION_HEADER: &str = "pulsify-session";

pub struct ChannelSink(Channel<Response>);
impl pulsify_sqlite::Sink for ChannelSink {
    fn deliver(&self, _session: u64, frame: Vec<u8>) -> bool {
        self.0.send(Response::new(frame)).is_ok()
    }
}

/// Managed state: the single SQLite writer and every open session.
///
/// The database opens on first use, so an unavailable file fails `open` with
/// `CONNECTION_FAILED` (retried by the webview) instead of the app's startup.
#[derive(Clone)]
pub struct Pulsify(Arc<State_>);
struct State_ {
    path: PathBuf,
    hub: Mutex<Option<Hub<ChannelSink>>>,
    owners: Mutex<HashMap<String, u64>>,
}
impl Pulsify {
    fn new(path: PathBuf) -> Self {
        Self(Arc::new(State_ {
            path,
            hub: Mutex::new(None),
            owners: Mutex::new(HashMap::new()),
        }))
    }
    /// Runs `work` with exclusive access to the store, e.g. for backups or maintenance.
    pub fn with_store<T>(
        &self,
        work: impl FnOnce(&mut SqliteStore) -> T,
    ) -> Result<T, CommandError> {
        self.with_hub(|hub| Ok(work(hub.store())))
    }
    fn lock(&self) -> MutexGuard<'_, Option<Hub<ChannelSink>>> {
        self.0.hub.lock().unwrap_or_else(PoisonError::into_inner)
    }
    fn with_hub<T>(
        &self,
        work: impl FnOnce(&mut Hub<ChannelSink>) -> pulsify_sqlite::Result<T>,
    ) -> Result<T, CommandError> {
        let mut hub = self.lock();
        if hub.is_none() {
            let unavailable = |error: &dyn std::fmt::Display| {
                CommandError::new("CONNECTION_FAILED", error.to_string())
            };
            if let Some(parent) = self.0.path.parent() {
                std::fs::create_dir_all(parent).map_err(|error| unavailable(&error))?;
            }
            let store = SqliteStore::open(&self.0.path).map_err(|error| unavailable(&error))?;
            *hub = Some(Hub::new(store));
        }
        work(hub.as_mut().expect("opened above")).map_err(CommandError::from)
    }
    async fn run<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut Hub<ChannelSink>) -> pulsify_sqlite::Result<T> + Send + 'static,
    ) -> Result<T, CommandError> {
        let state = self.clone();
        tauri::async_runtime::spawn_blocking(move || state.with_hub(work))
            .await
            .map_err(|error| CommandError::new("CONNECTION_FAILED", error.to_string()))?
    }
    fn owner_key(&self, label: &str) -> String {
        let owners = self.0.owners.lock().unwrap_or_else(PoisonError::into_inner);
        let generation = owners.get(label).copied().unwrap_or(0);
        format!("{label}:{generation}")
    }
    fn close_owner(&self, owner: &str) {
        let stale_owner = {
            let mut owners = self.0.owners.lock().unwrap_or_else(PoisonError::into_inner);
            let generation = owners.entry(owner.to_owned()).or_insert(0);
            let previous = *generation;
            *generation = generation.wrapping_add(1);
            format!("{owner}:{previous}")
        };
        let state = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Some(hub) = state.lock().as_mut() {
                hub.close_owner(&stale_owner);
            }
        });
    }
}

/// Serialized to the webview as `{ code, message }`, with a Pulsify error code.
#[derive(Debug, Serialize)]
pub struct CommandError {
    code: String,
    message: String,
}
impl CommandError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }
}
impl From<pulsify_sqlite::Error> for CommandError {
    fn from(error: pulsify_sqlite::Error) -> Self {
        Self::new(error.code, error.message)
    }
}

fn extract_raw_body(body: &InvokeBody) -> Option<Vec<u8>> {
    match body {
        InvokeBody::Raw(bytes) => Some(bytes.clone()),
        // IPC without a custom protocol serializes bytes as a JSON array.
        InvokeBody::Json(serde_json::Value::Array(values)) => values
            .iter()
            .map(|value| u8::try_from(value.as_u64()?).ok())
            .collect(),
        InvokeBody::Json(_) => None,
    }
}

fn parse_recovery_body(bytes: &[u8]) -> Result<(String, Vec<Vec<u8>>), CommandError> {
    let invalid = || CommandError::new("INVALID_MESSAGE", "Malformed recovery payload");
    let read_u32 = |offset: &mut usize| -> Result<usize, CommandError> {
        let end = offset.checked_add(4).ok_or_else(invalid)?;
        let slice = bytes.get(*offset..end).ok_or_else(invalid)?;
        *offset = end;
        Ok(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]) as usize)
    };
    let mut offset = 0;
    let doc_len = read_u32(&mut offset)?;
    let doc_end = offset.checked_add(doc_len).ok_or_else(invalid)?;
    let doc_bytes = bytes.get(offset..doc_end).ok_or_else(invalid)?;
    let doc_id = std::str::from_utf8(doc_bytes)
        .map_err(|_| invalid())?
        .to_owned();
    offset = doc_end;
    let mut frames = Vec::new();
    while offset < bytes.len() {
        let frame_len = read_u32(&mut offset)?;
        let frame_end = offset.checked_add(frame_len).ok_or_else(invalid)?;
        let frame = bytes.get(offset..frame_end).ok_or_else(invalid)?;
        offset = frame_end;
        frames.push(frame.to_vec());
    }
    Ok((doc_id, frames))
}

#[tauri::command]
async fn open<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Pulsify>,
    doc_id: String,
    channel: Channel<Response>,
) -> Result<u64, CommandError> {
    let owner = state.owner_key(webview.label());
    state
        .run(move |hub| hub.open(&doc_id, &owner, ChannelSink(channel)))
        .await
}

#[tauri::command]
async fn send(state: State<'_, Pulsify>, request: Request<'_>) -> Result<(), CommandError> {
    let session = request
        .headers()
        .get(SESSION_HEADER)
        .and_then(|value| value.to_str().ok()?.parse::<u64>().ok())
        .ok_or_else(|| CommandError::new("INVALID_MESSAGE", "Missing session header"))?;
    let bytes = extract_raw_body(request.body())
        .ok_or_else(|| CommandError::new("INVALID_MESSAGE", "Expected a binary frame"))?;
    state.run(move |hub| hub.send(session, &bytes)).await
}

#[tauri::command]
async fn close(state: State<'_, Pulsify>, session_id: u64) -> Result<(), CommandError> {
    state
        .run(move |hub| {
            hub.close(session_id);
            Ok(())
        })
        .await
}

#[tauri::command]
async fn cached(state: State<'_, Pulsify>, doc_id: String) -> Result<bool, CommandError> {
    state
        .run(move |hub| Ok(!hub.store().vector(&doc_id)?.is_empty()))
        .await
}

#[tauri::command]
async fn mark_deleted(state: State<'_, Pulsify>, request: Request<'_>) -> Result<(), CommandError> {
    let bytes = extract_raw_body(request.body()).ok_or_else(|| {
        CommandError::new("INVALID_MESSAGE", "Expected a binary recovery payload")
    })?;
    let (doc_id, frames) = parse_recovery_body(&bytes)?;
    state
        .run(move |hub| {
            let recovery = hub.store().mark_deleted(&doc_id, &frames);
            if hub.store().is_deleted(&doc_id)? {
                hub.retire_prefix(&doc_id)?;
            }
            recovery
        })
        .await
}

#[derive(Debug, Default)]
pub struct Builder {
    path: Option<PathBuf>,
}
impl Builder {
    pub fn new() -> Self {
        Self::default()
    }
    /// The database file. Relative paths resolve against the app data directory;
    /// defaults to `pulsify.sqlite` there.
    pub fn path(mut self, path: impl Into<PathBuf>) -> Self {
        self.path = Some(path.into());
        self
    }
    pub fn build<R: Runtime>(self) -> TauriPlugin<R> {
        PluginBuilder::new("pulsify")
            .invoke_handler(tauri::generate_handler![
                open,
                send,
                close,
                mark_deleted,
                cached
            ])
            .setup(move |app, _api| {
                let path = self.path.unwrap_or_else(|| "pulsify.sqlite".into());
                let path = if path.is_absolute() {
                    path
                } else {
                    app.path().app_data_dir()?.join(path)
                };
                app.manage(Pulsify::new(path));
                Ok(())
            })
            // A reloaded or closed webview loses its channels; drop its sessions.
            .on_page_load(|webview, payload| {
                if payload.event() == PageLoadEvent::Started {
                    if let Some(state) = webview.try_state::<Pulsify>() {
                        state.close_owner(webview.label());
                    }
                }
            })
            .on_event(|app, event| {
                if let RunEvent::WindowEvent {
                    label,
                    event: WindowEvent::Destroyed,
                    ..
                } = event
                {
                    if let Some(state) = app.try_state::<Pulsify>() {
                        state.close_owner(label);
                    }
                }
            })
            .build()
    }
}

/// The plugin with its default database, `pulsify.sqlite` in the app data directory.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new().build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;
    use std::time::{Duration, Instant};
    use tauri::test::{mock_builder, mock_context, noop_assets};

    #[test]
    fn k5_close_owner_does_not_block_calling_thread_or_race_with_new_sessions() {
        let dir =
            std::env::temp_dir().join(format!("tauri-plugin-pulsify-k5-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("pulsify.sqlite");
        let app = mock_builder()
            .plugin(Builder::new().path(&path).build())
            .build(mock_context(noop_assets()))
            .unwrap();
        let state = app.state::<Pulsify>().inner().clone();

        let measure_close = |hold: Duration| -> Duration {
            // Seed a session under the current generation of "main".
            let owner = state.owner_key("main");
            state
                .with_hub(|hub| {
                    hub.open("doc", &owner, ChannelSink(Channel::new(|_| Ok(()))))
                        .map(|_| ())
                })
                .unwrap();
            let entered = Arc::new(Barrier::new(2));
            let worker_state = state.clone();
            let worker_entered = entered.clone();
            let holder = std::thread::spawn(move || {
                worker_state
                    .with_store(|_| {
                        worker_entered.wait();
                        std::thread::sleep(hold);
                    })
                    .unwrap();
            });
            entered.wait();
            let start = Instant::now();
            state.close_owner("main");
            let elapsed = start.elapsed();

            // A session opened immediately after reload gets the next generation and survives.
            let fresh_owner = state.owner_key("main");
            assert_ne!(fresh_owner, owner);
            let fresh_id = tauri::async_runtime::block_on(state.run(move |hub| {
                hub.open("doc", &fresh_owner, ChannelSink(Channel::new(|_| Ok(()))))
            }))
            .unwrap();
            holder.join().unwrap();

            // Wait for the spawned cleanup to complete and verify only the stale session closed.
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                let count = state.with_hub(|hub| Ok(hub.session_count())).unwrap();
                if count == 1 {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "stale session was not closed (remaining={count})"
                );
                std::thread::sleep(Duration::from_millis(2));
            }
            // Clean up the fresh session.
            state
                .with_hub(|hub| {
                    assert!(hub.close(fresh_id));
                    Ok(())
                })
                .unwrap();
            elapsed
        };

        let short = measure_close(Duration::from_millis(40));
        let long = measure_close(Duration::from_millis(160));
        assert!(
            long < Duration::from_millis(25),
            "close_owner blocked the UI thread for {long:?} (short={short:?})"
        );
        drop(app);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
