use pulsify_protocol::{decode, encode, Body, Message, PatchRow};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody, RuntimeAuthority};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::utils::acl::resolved::{Resolved, ResolvedCommand};
use tauri::webview::InvokeRequest;
use tauri::{App, Manager, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_pulsify::{Builder, Pulsify, SESSION_HEADER};

type Frames = Arc<Mutex<Vec<(u32, Message)>>>;

fn app(
    path: &std::path::Path,
    allowed: &[&str],
) -> (App<MockRuntime>, WebviewWindow<MockRuntime>, Frames) {
    let mut context = mock_context(noop_assets());
    let mut resolved = Resolved::default();
    for command in allowed {
        resolved.allowed_commands.insert(
            format!("plugin:pulsify|{command}"),
            vec![ResolvedCommand {
                windows: vec![glob::Pattern::new("*").unwrap()],
                ..Default::default()
            }],
        );
    }
    *context.runtime_authority_mut() = RuntimeAuthority::new(Default::default(), resolved);
    let frames = Frames::default();
    let captured = frames.clone();
    let app = mock_builder()
        .plugin(Builder::new().path(path).build())
        .channel_interceptor(move |_webview, callback, _index, body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                captured
                    .lock()
                    .unwrap()
                    .push((callback.0, decode(bytes).unwrap()));
            }
            true
        })
        .build(context)
        .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (app, webview, frames)
}

fn invoke(
    webview: &WebviewWindow<MockRuntime>,
    command: &str,
    body: InvokeBody,
    session: Option<u64>,
) -> Result<Value, Value> {
    let mut headers = tauri::http::HeaderMap::new();
    if let Some(session) = session {
        headers.insert(SESSION_HEADER, session.to_string().parse().unwrap());
    }
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: format!("plugin:pulsify|{command}"),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: if cfg!(any(windows, target_os = "android")) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body,
            headers,
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    )
    .map(|body| body.deserialize::<Value>().unwrap())
}

fn frame(request_id: u64, body: Body) -> Vec<u8> {
    encode(&Message {
        doc_id: "doc".into(),
        request_id,
        body,
    })
    .unwrap()
}

#[test]
fn commands_open_relay_broadcast_and_close_sessions() {
    let directory =
        std::env::temp_dir().join(format!("tauri-plugin-pulsify-{}", std::process::id()));
    let path = directory.join("nested/pulsify.sqlite");
    let _ = std::fs::remove_dir_all(&directory);
    let (app, webview, frames) = app(&path, &["open", "send", "close"]);
    let open = |channel: u32| {
        invoke(
            &webview,
            "open",
            InvokeBody::Json(
                json!({ "docId": "doc", "channel": format!("__CHANNEL__:{channel}") }),
            ),
            None,
        )
    };
    let first = open(11).unwrap().as_u64().unwrap();
    let second = open(12).unwrap().as_u64().unwrap();
    assert_ne!(first, second);
    assert!(path.exists(), "the database directory is created");

    let connect = frame(1, Body::Connect { vv: vec![] });
    invoke(&webview, "send", InvokeBody::Raw(connect), Some(first)).unwrap();
    let row = PatchRow {
        doc_id: "doc".into(),
        sid: 65536,
        clock: 1,
        span: 1,
        dependencies: vec![],
        operations: vec![1, 2, 3],
    };
    let upload = frame(
        2,
        Body::SyncBack {
            vv: vec![],
            rows: vec![row.clone()],
        },
    );
    // Without a custom protocol, bytes arrive as a JSON array.
    let as_json = InvokeBody::Json(json!(upload));
    invoke(&webview, "send", as_json, Some(first)).unwrap();
    let received = std::mem::take(&mut *frames.lock().unwrap());
    let summary: Vec<(u32, u64, &Body)> = received
        .iter()
        .map(|(channel, message)| (*channel, message.request_id, &message.body))
        .collect();
    assert_eq!(
        summary,
        vec![
            (
                11,
                1,
                &Body::Sync {
                    found: false,
                    complete: true,
                    vv: vec![],
                    rows: vec![]
                }
            ),
            (
                11,
                2,
                &Body::Ack {
                    vv: vec![(65536, 2)]
                }
            ),
            (
                12,
                0,
                &Body::Update {
                    vv: vec![(65536, 2)],
                    rows: vec![row]
                }
            ),
        ]
    );

    let error = invoke(&webview, "send", InvokeBody::Raw(vec![1]), Some(first)).unwrap_err();
    assert_eq!(error["code"], "INVALID_MESSAGE");
    let error = invoke(&webview, "send", InvokeBody::Raw(vec![1]), None).unwrap_err();
    assert_eq!(error["code"], "INVALID_MESSAGE");
    let invalid = InvokeBody::Json(json!({ "docId": "", "channel": "__CHANNEL__:13" }));
    let error = invoke(&webview, "open", invalid, None).unwrap_err();
    assert_eq!(error["code"], "INVALID_MESSAGE");

    invoke(
        &webview,
        "close",
        InvokeBody::Json(json!({ "sessionId": first })),
        None,
    )
    .unwrap();
    let connect = frame(3, Body::Connect { vv: vec![] });
    let error = invoke(&webview, "send", InvokeBody::Raw(connect), Some(first)).unwrap_err();
    assert_eq!(error["code"], "CLOSED");
    let vector = app
        .state::<Pulsify>()
        .with_store(|store| store.vector("doc").unwrap())
        .unwrap();
    assert_eq!(vector, vec![(65536, 2)]);
    drop(webview);
    drop(app);
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn commands_require_a_capability() {
    let path = std::env::temp_dir().join(format!(
        "tauri-plugin-pulsify-acl-{}.sqlite",
        std::process::id()
    ));
    let (_app, webview, _frames) = app(&path, &["send", "close"]);
    let body = InvokeBody::Json(json!({ "docId": "doc", "channel": "__CHANNEL__:1" }));
    let error = invoke(&webview, "open", body, None).unwrap_err();
    assert!(error.as_str().unwrap().contains("not allowed"), "{error}");
    drop(webview);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn an_unavailable_database_fails_open_without_failing_startup() {
    let blocker = std::env::temp_dir().join(format!(
        "tauri-plugin-pulsify-blocked-{}",
        std::process::id()
    ));
    std::fs::write(&blocker, b"a file where a directory is expected").unwrap();
    let (_app, webview, _frames) = app(&blocker.join("pulsify.sqlite"), &["open"]);
    let body = InvokeBody::Json(json!({ "docId": "doc", "channel": "__CHANNEL__:1" }));
    let error = invoke(&webview, "open", body, None).unwrap_err();
    // Retryable by the webview: the next attempt opens the database again.
    assert_eq!(error["code"], "CONNECTION_FAILED", "{error}");
    std::fs::remove_file(&blocker).unwrap();
    let body = InvokeBody::Json(json!({ "docId": "doc", "channel": "__CHANNEL__:2" }));
    assert!(invoke(&webview, "open", body, None).unwrap().is_u64());
    drop(webview);
    let _ = std::fs::remove_dir_all(&blocker);
}
