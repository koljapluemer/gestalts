//! The bridge on 127.0.0.1: a site asks to be allowed (`POST /pair`, the person confirms in a dialog), then runs
//! turns over a WebSocket (`/runs`), answering the tool calls claude makes in them. The MCP shim reaches a running
//! turn under `/internal`, with that turn's secret; browsers can't (they always send an Origin).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot};
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::claude::{self, Claude};
use crate::config::{Paths, Tokens, write_secret};
use crate::run::{self, FromPage, Live, ToPage};
use crate::NAME;

/// Whether the person lets `origin` run Claude here (a dialog; blocking).
pub trait Asker: Send + Sync {
    fn allow(&self, origin: &str) -> bool;
}

pub struct Bridge {
    pub paths: Paths,
    /// development: localhost sites are allowed without asking
    pub dev: bool,
    pub tokens: Mutex<Tokens>,
    asker: Arc<dyn Asker>,
    /// the port the internal URL is on, once bound
    port: Mutex<u16>,
    runs: Mutex<HashMap<String, Arc<Live>>>,
    busy: Mutex<HashSet<PathBuf>>,
    claude: Mutex<Option<(Instant, Claude)>>,
    asking: tokio::sync::Mutex<()>,
    /// this program, which claude starts as the MCP shim
    exe: PathBuf,
}

impl Bridge {
    pub fn new(paths: Paths, dev: bool, asker: Arc<dyn Asker>) -> Result<Arc<Bridge>, String> {
        let exe = std::env::current_exe().map_err(|e| format!("cannot find this program: {e}"))?;
        Ok(Arc::new(Bridge {
            tokens: Mutex::new(Tokens::load(&paths)), paths, dev, asker, port: Mutex::new(0), runs: Mutex::default(),
            busy: Mutex::default(), claude: Mutex::new(None), asking: tokio::sync::Mutex::new(()), exe,
        }))
    }

    /// What `claude --version` said, at most 15 s ago.
    pub async fn claude(&self) -> Claude {
        if let Some((at, c)) = self.claude.lock().expect("claude lock").clone() && at.elapsed() < Duration::from_secs(15) { return c; }
        let c = tokio::task::spawn_blocking(claude::probe).await.unwrap_or(Claude { found: false, path: None, version: None });
        *self.claude.lock().expect("claude lock") = Some((Instant::now(), c.clone()));
        c
    }

    fn authorized(&self, origin: Option<&str>, token: Option<&str>) -> bool {
        let Some(origin) = origin else { return false };
        (self.dev && is_local(origin)) || token.is_some_and(|t| self.tokens.lock().expect("tokens lock").allows(origin, t))
    }

    pub fn forget_all(&self) -> Result<(), String> {
        let mut tokens = self.tokens.lock().expect("tokens lock");
        tokens.0.clear();
        tokens.save(&self.paths).map_err(|e| e.to_string())
    }
}

/// `http://localhost:<port>` and the like: a page on this computer (development).
fn is_local(origin: &str) -> bool {
    let rest = origin.strip_prefix("http://").unwrap_or("");
    let host = rest.rsplit_once(':').map_or(rest, |(h, p)| if p.chars().all(|c| c.is_ascii_digit()) { h } else { rest });
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

/// An origin as browsers send it: scheme and host, no path.
fn is_origin(o: &str) -> bool {
    let host = o.strip_prefix("https://").or_else(|| o.strip_prefix("http://"));
    host.is_some_and(|h| !h.is_empty() && !h.contains('/')) && o.len() < 300 && o.chars().all(|c| c.is_ascii_graphic())
}

fn origin(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()).filter(|o| is_origin(o))
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "))
}

pub fn app(bridge: Arc<Bridge>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::mirror_request())
        .allow_methods([axum::http::Method::GET, axum::http::Method::POST])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
        .allow_private_network(true);
    let public = Router::new().route("/status", get(status)).route("/pair", post(pair)).layer(cors);
    Router::new()
        .merge(public)
        .route("/runs", get(runs))
        .route("/internal/runs/{id}/tools", get(internal_tools))
        .route("/internal/runs/{id}/calls", post(internal_call))
        .with_state(bridge)
}

/// Serves until `stop` resolves.
pub async fn serve(bridge: Arc<Bridge>, listener: tokio::net::TcpListener, stop: impl std::future::Future<Output = ()> + Send + 'static) -> Result<(), String> {
    *bridge.port.lock().expect("port lock") = listener.local_addr().map_err(|e| e.to_string())?.port();
    axum::serve(listener, app(bridge)).with_graceful_shutdown(stop).await.map_err(|e| e.to_string())
}

async fn status(State(b): State<Arc<Bridge>>, headers: HeaderMap) -> Json<Value> {
    let paired = b.authorized(origin(&headers), bearer(&headers));
    Json(json!({ "app": NAME, "version": env!("CARGO_PKG_VERSION"), "claude": b.claude().await, "paired": paired }))
}

/// A site asks to run Claude here: the person decides, once per site.
async fn pair(State(b): State<Arc<Bridge>>, headers: HeaderMap) -> Response {
    let Some(origin) = origin(&headers).map(str::to_owned) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "a site asks from a web page (no Origin)" }))).into_response();
    };
    // one dialog at a time
    let _asking = b.asking.lock().await;
    if let Some(t) = b.tokens.lock().expect("tokens lock").0.get(&origin) { return Json(json!({ "token": t })).into_response(); }
    let allowed = (b.dev && is_local(&origin)) || {
        let (asker, o) = (b.asker.clone(), origin.clone());
        tokio::task::spawn_blocking(move || asker.allow(&o)).await.unwrap_or(false)
    };
    if !allowed { return (StatusCode::FORBIDDEN, Json(json!({ "error": "not allowed on this computer" }))).into_response(); }
    let token = uuid::Uuid::new_v4().simple().to_string() + &uuid::Uuid::new_v4().simple().to_string();
    let mut tokens = b.tokens.lock().expect("tokens lock");
    tokens.0.insert(origin, token.clone());
    if let Err(e) = tokens.save(&b.paths) {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": format!("cannot remember the site: {e}") }))).into_response();
    }
    Json(json!({ "token": token })).into_response()
}

#[derive(Deserialize)]
struct RunQuery {
    token: Option<String>,
}

async fn runs(State(b): State<Arc<Bridge>>, headers: HeaderMap, Query(q): Query<RunQuery>, ws: WebSocketUpgrade) -> Response {
    let origin = origin(&headers).map(str::to_owned);
    if !b.authorized(origin.as_deref(), q.token.as_deref()) {
        return (StatusCode::FORBIDDEN, "this site isn't allowed to run Claude here: pair it first").into_response();
    }
    let origin = origin.expect("authorized has one");
    ws.max_message_size(64 << 20).max_frame_size(64 << 20).on_upgrade(move |socket| session(socket, b, origin))
}

async fn send(sink: &mut futures_util::stream::SplitSink<WebSocket, Message>, ev: &ToPage) -> bool {
    sink.send(Message::Text(serde_json::to_string(ev).unwrap_or_default().into())).await.is_ok()
}

/// One turn over one socket: `start`, then tool results until claude is done. Closing the socket stops it.
async fn session(socket: WebSocket, b: Arc<Bridge>, origin: String) {
    let (mut sink, mut stream) = socket.split();
    let fail = |message: String| ToPage::Error { message };
    let start = match stream.next().await {
        Some(Ok(Message::Text(t))) => match serde_json::from_str::<FromPage>(&t) {
            Ok(FromPage::Start(s)) => s,
            Ok(_) => { let _ = send(&mut sink, &fail("the first message must be `start`".into())).await; return; }
            Err(e) => { let _ = send(&mut sink, &fail(format!("not a request: {e}"))).await; return; }
        },
        _ => return,
    };
    let keep = match run::validate(&start) {
        Ok(k) => k,
        Err(e) => { let _ = send(&mut sink, &fail(e)).await; let _ = send(&mut sink, &ToPage::Done { session: start.session }).await; return; }
    };
    let c = b.claude().await;
    let Some(claude_path) = c.path.filter(|_| c.found) else {
        let _ = send(&mut sink, &fail("Claude Code isn't installed on this computer, or can't be found: install it (claude.com/claude-code), sign in once in a terminal, then try again".into())).await;
        let _ = send(&mut sink, &ToPage::Done { session: start.session }).await;
        return;
    };
    let site = hex(&Sha256::digest(origin.as_bytes())[..8]);
    let dir = b.paths.workspaces().join(site).join(&start.workspace);
    if !b.busy.lock().expect("busy lock").insert(dir.clone()) {
        let _ = send(&mut sink, &fail("a turn is already running for this draft".into())).await;
        let _ = send(&mut sink, &ToPage::Done { session: start.session }).await;
        return;
    }
    let _busy = Busy(&b.busy, dir.clone());
    let (prepared, start) = {
        let (d, k) = (dir.clone(), keep.clone());
        tokio::task::spawn_blocking(move || (run::prepare(&d, &start, &k), start)).await.expect("prepare ran")
    };
    let outside = match prepared {
        Ok(o) => o,
        Err(e) => { let _ = send(&mut sink, &fail(e)).await; let _ = send(&mut sink, &ToPage::Done { session: start.session }).await; return; }
    };

    let id = uuid::Uuid::new_v4().simple().to_string();
    let secret = uuid::Uuid::new_v4().simple().to_string();
    let port = *b.port.lock().expect("port lock");
    let mcp_config = dir.join(".bridge").join("mcp.json");
    let config = json!({ "mcpServers": { run::MCP_SERVER: {
        "type": "stdio", "command": b.exe, "args": ["mcp"],
        "env": { "GESTALTS_BRIDGE_CALLS": format!("http://127.0.0.1:{port}/internal/runs/{id}"), "GESTALTS_BRIDGE_SECRET": secret },
    } } });
    if let Err(e) = write_secret(&mcp_config, serde_json::to_vec_pretty(&config).unwrap_or_default()) {
        let _ = send(&mut sink, &fail(format!("cannot write the tools' config: {e}"))).await;
        let _ = send(&mut sink, &ToPage::Done { session: start.session }).await;
        return;
    }
    let (out, mut out_rx) = mpsc::unbounded_channel();
    let live = Arc::new(Live { secret, tools: start.tools.clone(), workspace: dir.clone(), keep, out, pending: Mutex::default() });
    b.runs.lock().expect("runs lock").insert(id.clone(), live.clone());
    let (cancel, cancelled) = oneshot::channel();
    let command = run::Command { claude: claude_path, mcp_config };
    let task = tokio::spawn(run::run(command, *start, live.clone(), b.paths.runs(), outside, cancelled));
    let mut cancel = Some(cancel);
    loop {
        tokio::select! {
            ev = out_rx.recv() => match ev {
                Some(ev) => {
                    let done = matches!(ev, ToPage::Done { .. });
                    if !send(&mut sink, &ev).await && let Some(c) = cancel.take() { let _ = c.send(()); }
                    if done { break; }
                }
                None => break,
            },
            msg = stream.next(), if cancel.is_some() => match msg {
                Some(Ok(Message::Text(t))) => match serde_json::from_str::<FromPage>(&t) {
                    Ok(FromPage::ToolResult { id, content, is_error }) => live.answer(&id, content, is_error),
                    Ok(FromPage::Cancel) => { if let Some(c) = cancel.take() { let _ = c.send(()); } }
                    _ => {}
                },
                Some(Ok(_)) => {}
                // the page went away: stop claude, then finish quietly
                _ => { if let Some(c) = cancel.take() { let _ = c.send(()); } }
            },
        }
    }
    let _ = task.await;
    b.runs.lock().expect("runs lock").remove(&id);
    let _ = sink.close().await;
}

struct Busy<'a>(&'a Mutex<HashSet<PathBuf>>, PathBuf);
impl Drop for Busy<'_> {
    fn drop(&mut self) { self.0.lock().expect("busy lock").remove(&self.1); }
}

fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }

/// The running turn, for its shim: no Origin (no browser), and its secret.
fn live(b: &Bridge, id: &str, headers: &HeaderMap) -> Result<Arc<Live>, StatusCode> {
    if headers.contains_key(header::ORIGIN) { return Err(StatusCode::FORBIDDEN); }
    let live = b.runs.lock().expect("runs lock").get(id).cloned().ok_or(StatusCode::NOT_FOUND)?;
    let secret = headers.get("x-bridge-secret").and_then(|v| v.to_str().ok()).unwrap_or("");
    if secret.len() != live.secret.len() || secret != live.secret { return Err(StatusCode::FORBIDDEN); }
    Ok(live)
}

async fn internal_tools(State(b): State<Arc<Bridge>>, Path(id): Path<String>, headers: HeaderMap) -> Response {
    match live(&b, &id, &headers) {
        Ok(l) => Json(json!({ "tools": l.tools.iter().map(|t| json!({ "name": t.name, "description": t.description, "inputSchema": t.input_schema })).collect::<Vec<_>>() })).into_response(),
        Err(s) => s.into_response(),
    }
}

#[derive(Deserialize)]
struct Call {
    name: String,
    #[serde(default)]
    arguments: Value,
}

async fn internal_call(State(b): State<Arc<Bridge>>, Path(id): Path<String>, headers: HeaderMap, Json(call): Json<Call>) -> Response {
    match live(&b, &id, &headers) {
        Ok(l) => Json(l.call(&call.name, call.arguments).await).into_response(),
        Err(s) => s.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins() {
        assert!(is_local("http://localhost:5173") && is_local("http://127.0.0.1:1") && is_local("http://[::1]:80") && is_local("http://localhost"));
        assert!(!is_local("https://localhost.example.com") && !is_local("http://localhost.evil:1") && !is_local("https://app.example"));
        assert!(is_origin("https://app.example") && is_origin("http://localhost:5173"));
        assert!(!is_origin("null") && !is_origin("https://a.b/path") && !is_origin("file://"));
    }
}
