//! Pulsify Cloud for Unikraft Cloud. Replaces the Cloudflare Worker (gateway)
//! and Durable Objects (one actor per root) with one process; PostgreSQL,
//! running beside it on a Unix socket, replaces each object's SQLite.
mod access;
mod auth;
mod http;
mod hub;
mod store;

use auth::{
    authenticate, read_credential, read_subprotocols, Caller, Secrets, SUBPROTOCOL_E1,
    SUBPROTOCOL_E2,
};
use axum::body::{to_bytes, Body};
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Request, State};
use axum::http::{header, Method, Response, StatusCode};
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use http::{json_response, parse_path, preflight_response, query_param, Action, CloudError};
use hub::{Hub, Outgoing};
use serde_json::{json, Value};
use std::sync::Arc;
use store::Store;
use tokio::sync::mpsc;

#[derive(Clone)]
struct App {
    hub: Arc<Hub>,
    secrets: Arc<Secrets>,
    /// First frame of every socket: who answers it.
    welcome: Arc<str>,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let secrets = Secrets {
        token_secret: env("PULSIFY_TOKEN_SECRET").ok_or("PULSIFY_TOKEN_SECRET is required")?,
        api_key: env("PULSIFY_API_KEY").ok_or("PULSIFY_API_KEY is required")?,
    };
    if secrets.token_secret.len() < 32 || secrets.api_key.len() < 32 {
        return Err("PULSIFY_TOKEN_SECRET and PULSIFY_API_KEY need at least 32 characters".into());
    }
    let database = env("DATABASE_URL")
        .unwrap_or_else(|| "host=/var/run/postgresql user=postgres dbname=postgres".into());
    let pool_size = env("PULSIFY_POOL_SIZE")
        .and_then(|size| size.parse().ok())
        .unwrap_or(16);
    let store = Store::connect(&database, pool_size)?;
    store
        .initialize(60)
        .await
        .map_err(|error| format!("Cannot initialize PostgreSQL: {}", error.message))?;
    // A fresh ID per boot when none is configured: clients see restarts.
    let instance = env("PULSIFY_INSTANCE")
        .or_else(|| env("HOSTNAME"))
        .unwrap_or_else(|| format!("boot-{:x}", std::process::id() as u64 ^ now_nanos()));
    let mut server = json!({ "backend": "unikraft-cloud", "id": instance });
    if let Some(location) = env("PULSIFY_LOCATION") {
        server["location"] = json!(location);
    }
    let app = App {
        hub: Hub::new(store),
        secrets: Arc::new(secrets),
        welcome: json!({ "type": "welcome", "server": server })
            .to_string()
            .into(),
    };
    let port = env("PORT").unwrap_or_else(|| "8080".into());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}")).await?;
    eprintln!("pulsify-cloud: listening on port {port}");
    axum::serve(listener, Router::new().fallback(handle).with_state(app))
        .with_graceful_shutdown(async {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("signal handler");
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = terminate.recv() => {},
            }
        })
        .await?;
    Ok(())
}

/// The gateway: route, authenticate, negotiate, then hand over to the root.
async fn handle(State(app): State<App>, request: Request) -> Response<Body> {
    match route(app, request).await {
        Ok(response) => response,
        Err(error) => error.response(),
    }
}

async fn route(app: App, request: Request) -> Result<Response<Body>, CloudError> {
    if request.method() == Method::OPTIONS {
        return Ok(preflight_response());
    }
    let path = request.uri().path().to_owned();
    if path == "/v1/health" {
        return Ok(json_response(StatusCode::OK, &json!({ "ok": true })));
    }
    let (root, action) =
        parse_path(&path)?.ok_or_else(|| CloudError::new("NOT_FOUND", "Unknown route"))?;
    let headers = request.headers();
    let query = request.uri().query().map(str::to_owned);
    let protocols = headers
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok());
    let credential = read_credential(
        headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok()),
        protocols,
        query_param(query.as_deref(), "token"),
    );
    if action == Action::Connect {
        let upgrade = headers.get(header::UPGRADE).and_then(|v| v.to_str().ok());
        if !upgrade.is_some_and(|v| v.eq_ignore_ascii_case("websocket")) {
            return Err(CloudError::new(
                "UPGRADE_REQUIRED",
                "Expected a WebSocket upgrade",
            ));
        }
        let envelope = read_subprotocols(protocols)
            .0
            .ok_or_else(|| CloudError::new("BAD_REQUEST", "Offer a pulsify-cloud.1 subprotocol"))?;
        let Some(Caller::User(subject)) = authenticate(credential, &app.secrets)? else {
            return Err(CloudError::new("UNAUTHORIZED", "A user token is required"));
        };
        let (mut parts, _) = request.into_parts();
        let upgrade = WebSocketUpgrade::from_request_parts(&mut parts, &())
            .await
            .map_err(|_| CloudError::new("BAD_REQUEST", "Invalid WebSocket upgrade"))?;
        let protocol = if envelope == 2 {
            SUBPROTOCOL_E2
        } else {
            SUBPROTOCOL_E1
        };
        return Ok(upgrade
            .protocols([protocol])
            .max_message_size(pulsify_protocol::MAX_FRAME_BYTES + 1024)
            .on_upgrade(move |socket| {
                connection(socket, app.hub, app.welcome, root, subject, envelope)
            }));
    }
    let caller = authenticate(credential, &app.secrets)?
        .ok_or_else(|| CloudError::new("UNAUTHORIZED", "Missing credentials"))?;
    let method = request.method().clone();
    let lease = app.hub.lease(&root);
    let store = &app.hub.store;
    let body = match (action, method) {
        (Action::Usage, _) => lease.root.usage(store, &caller).await?,
        (_, Method::GET) => {
            lease
                .root
                .list_grants(
                    store,
                    &caller,
                    query_param(query.as_deref(), "subject"),
                    query_param(query.as_deref(), "prefix"),
                )
                .await?
        }
        (_, Method::PUT) => {
            let bytes = to_bytes(request.into_body(), 64 * 1024)
                .await
                .map_err(|_| CloudError::new("LIMIT_EXCEEDED", "Request body is too large"))?;
            let input: Value = serde_json::from_slice(&bytes)
                .map_err(|_| CloudError::new("BAD_REQUEST", "Expected a JSON body"))?;
            lease.root.put_grant(store, &caller, input).await?
        }
        (_, Method::DELETE) => {
            lease
                .root
                .delete_grant(
                    store,
                    &caller,
                    query_param(query.as_deref(), "subject"),
                    query_param(query.as_deref(), "prefix"),
                )
                .await?
        }
        _ => {
            return Err(CloudError::new(
                "METHOD_NOT_ALLOWED",
                "Use GET, PUT or DELETE",
            ))
        }
    };
    Ok(json_response(StatusCode::OK, &body))
}

/// One authenticated socket: the reader feeds the root in order, a writer drains its queue.
async fn connection(
    socket: WebSocket,
    hub: Arc<Hub>,
    welcome: Arc<str>,
    root: String,
    subject: String,
    envelope: u8,
) {
    let lease = hub.lease(&root);
    let id = hub.connection_id();
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let heartbeat = tx.clone();
    let _ = tx.send(Outgoing::Text(welcome.to_string()));
    lease.root.join(id, subject, envelope, tx).await;
    let writer = tokio::spawn(async move {
        while let Some(outgoing) = rx.recv().await {
            let sent = match outgoing {
                Outgoing::Binary(bytes) => sink.send(Message::Binary(bytes.into())).await,
                Outgoing::Text(text) => sink.send(Message::Text(text.into())).await,
                Outgoing::Close(code, reason) => {
                    let frame = CloseFrame {
                        code,
                        reason: reason.into(),
                    };
                    let _ = sink.send(Message::Close(Some(frame))).await;
                    break;
                }
            };
            if sent.is_err() {
                break;
            }
        }
    });
    while let Some(Ok(message)) = stream.next().await {
        let open = match message {
            Message::Binary(bytes) => lease.root.receive_binary(&hub.store, id, &bytes).await,
            Message::Text(text) if text.as_str() == auth::PING => {
                heartbeat.send(Outgoing::Text(auth::PONG.into())).is_ok()
            }
            Message::Text(text) => lease.root.receive_text(id, text.as_str()).await,
            Message::Close(_) => false,
            _ => true,
        };
        if !open {
            break;
        }
    }
    lease.root.leave(id).await;
    drop(heartbeat);
    let _ = writer.await;
}

fn now_nanos() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos() as u64)
        .unwrap_or_default()
}
