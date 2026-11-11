//! Tauri 2 plugin persisting Pulsify documents in a local SQLite database.
//!
//! Register it with `.plugin(tauri_plugin_pulsify::init())` and connect documents
//! with `createTauriConnector()` from `pulsify-tauri`.
use pulsify_sqlite::{Hub, SqliteStore};
use serde::Serialize;
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
}
impl Pulsify {
    fn new(path: PathBuf) -> Self {
        Self(Arc::new(State_ {
            path,
            hub: Mutex::new(None),
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
    fn close_owner(&self, owner: &str) {
        if let Some(hub) = self.lock().as_mut() {
            hub.close_owner(owner);
        }
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

#[tauri::command]
async fn open<R: Runtime>(
    webview: Webview<R>,
    state: State<'_, Pulsify>,
    doc_id: String,
    channel: Channel<Response>,
) -> Result<u64, CommandError> {
    let owner = webview.label().to_owned();
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
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => Some(bytes.clone()),
        // IPC without a custom protocol serializes bytes as a JSON array.
        InvokeBody::Json(serde_json::Value::Array(values)) => values
            .iter()
            .map(|value| u8::try_from(value.as_u64()?).ok())
            .collect(),
        InvokeBody::Json(_) => None,
    }
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
            .invoke_handler(tauri::generate_handler![open, send, close])
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
