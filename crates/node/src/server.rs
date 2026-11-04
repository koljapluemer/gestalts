//! The HTTP API on 127.0.0.1: notes and blobs of the open folder for the web apps, change events, scoped access
//! for plugin workers, `/control/*` for the embedding app, and the app's own web frontend if it has one.

// handlers return `Result<_, Response>`, axum's idiom; the large error only ever goes straight out as a reply
#![allow(clippy::result_large_err)]

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, Path as UrlPath, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{any, get, post, put};
use gestalts_core::StorageError;
use gestalts_fs::FsStorage;
use serde::{Deserialize, Serialize};
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::paths::{Config, Paths};
use crate::plugins::{PluginHost, PluginView};
use crate::uv::UvState;
use crate::watch::{Event, Events};

/// Header carrying the per-run control token (see `paths::Paths::control_token_file`).
pub const CONTROL_HEADER: &str = "x-gestalts-control";
/// A frontend counts as connected if it made a request this recently (they sync every 15 s, and an open `/events`
/// socket counts every 20 s).
const CONNECTED_FOR: Duration = Duration::from_secs(60);
const EVENTS_PING: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FolderInfo {
    /// stable per folder, so syncing clients can tell one folder from another behind the same URL
    pub id: String,
    pub path: String,
}

pub struct Folder {
    store: Arc<FsStorage>,
    info: FolderInfo,
}

impl Folder {
    /// Opens (and if needed creates) a data folder with `notes/`, `blobs/` and `.gestalts/folder-id`.
    pub fn open(path: &Path) -> Result<Folder, String> {
        for sub in ["notes", "blobs"] {
            std::fs::create_dir_all(path.join(sub)).map_err(|e| format!("cannot use {}: {e}", path.display()))?;
        }
        let root = path.canonicalize().map_err(|e| e.to_string())?;
        let id_file = root.join(".gestalts").join("folder-id");
        let id = match std::fs::read_to_string(&id_file) {
            Ok(id) if !id.trim().is_empty() => id.trim().to_owned(),
            _ => {
                let id = uuid::Uuid::new_v4().to_string();
                crate::paths::write_atomic(&id_file, id.as_bytes()).map_err(|e| format!("cannot write {}: {e}", id_file.display()))?;
                id
            }
        };
        Ok(Folder { store: Arc::new(FsStorage::new(&root)), info: FolderInfo { id, path: root.display().to_string() } })
    }

    pub fn info(&self) -> &FolderInfo { &self.info }
}

/// What the embedding app can do for the node and its web frontend: a native folder picker, the file manager, start
/// on login. The defaults are a headless node's: it can do none of it.
pub trait Shell: Send + Sync + 'static {
    /// "open the app" (launched again, or `/control/show`)
    fn show(&self) {}
    fn quit(&self) {}
    fn folder_changed(&self, _folder: Option<&FolderInfo>) {}
    /// A native folder picker; blocks until the user picked one or cancelled. Runs on a blocking thread.
    fn choose_folder(&self) -> Option<PathBuf> { None }
    /// Shows the folder in the file manager.
    fn reveal(&self, _path: &Path) -> Result<(), String> { Err("not available here".into()) }
    /// Whether the app starts on login; `None` if it can't.
    fn autostart(&self) -> Option<bool> { None }
    fn set_autostart(&self, _on: bool) -> Result<(), String> { Err("not available here".into()) }
}

/// The headless node's shell.
pub struct Headless;
impl Shell for Headless {}

/// An app's web frontend (a static build) the node serves at `/`.
#[derive(Clone)]
pub enum AppFiles {
    Embedded(&'static include_dir::Dir<'static>),
    Disk(PathBuf),
}

impl AppFiles {
    fn read(&self, path: &str) -> Option<std::borrow::Cow<'static, [u8]>> {
        // only plain relative paths: no `..`, no root, no drive
        if path.is_empty() || !Path::new(path).components().all(|c| matches!(c, Component::Normal(_))) { return None; }
        match self {
            AppFiles::Embedded(dir) => dir.get_file(path).map(|f| f.contents().into()),
            AppFiles::Disk(root) => std::fs::read(root.join(path)).ok().map(Into::into),
        }
    }
}

/// Who the node is and what it serves besides the API.
#[derive(Clone)]
pub struct Identity {
    /// `app` in `/health`, e.g. `gestalter`
    pub name: &'static str,
    pub app: Option<AppFiles>,
}

#[derive(Clone)]
pub struct AppState {
    folder: Arc<RwLock<Option<Arc<Folder>>>>,
    /// watches the open folder; replaced with it
    watcher: Arc<Mutex<Option<notify::RecommendedWatcher>>>,
    events: Events,
    plugins: PluginHost,
    clients: Arc<Mutex<BTreeMap<String, Instant>>>,
    control_token: Arc<str>,
    /// where to remember a newly chosen folder; None when the folder came from the command line
    remember_in: Option<Paths>,
    shell: Arc<dyn Shell>,
    identity: Identity,
    address: String,
    /// web origins allowed besides localhost and the app's own frontends
    extra_origins: Arc<[String]>,
}

impl AppState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(folder: Option<Folder>, plugins: PluginHost, control_token: String, remember_in: Option<Paths>,
               shell: Arc<dyn Shell>, identity: Identity, address: String, extra_origins: Vec<String>) -> Self {
        let state = AppState { folder: Arc::default(), watcher: Arc::default(), events: Events::default(), plugins, clients: Arc::default(),
                               control_token: control_token.into(), remember_in, shell, identity, address, extra_origins: extra_origins.into() };
        if let Some(f) = folder { state.set_folder(f); }
        state
    }

    fn folder(&self) -> Option<Arc<Folder>> { self.folder.read().expect("folder lock").clone() }

    /// Serves `folder` from now on and watches it for changes.
    fn set_folder(&self, folder: Folder) {
        let watcher = self.events.watch(Path::new(&folder.info.path));
        *self.watcher.lock().expect("watcher lock") = watcher;
        *self.folder.write().expect("folder lock") = Some(Arc::new(folder));
    }

    fn store(&self) -> Result<Arc<FsStorage>, Response> {
        self.folder().map(|f| f.store.clone())
            .ok_or_else(|| (StatusCode::CONFLICT, "no folder open; choose one in the Gestalter desktop app").into_response())
    }

    fn status(&self, plugins: Vec<PluginView>) -> StatusView {
        let now = Instant::now();
        let clients = self.clients.lock().expect("clients lock").iter()
            .filter(|(_, seen)| now.duration_since(**seen) < CONNECTED_FOR)
            .map(|(origin, seen)| ClientView { origin: origin.clone(), seconds_ago: now.duration_since(*seen).as_secs() })
            .collect();
        StatusView { version: env!("CARGO_PKG_VERSION").into(), address: self.address.clone(), folder: self.folder().map(|f| f.info.clone()),
                     clients, plugins, uv: self.plugins.uv_state(), autostart: self.shell.autostart() }
    }
}

struct ApiError(StorageError);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self.0 {
            StorageError::InvalidKey(_) => StatusCode::BAD_REQUEST,
            StorageError::ReadOnly => StatusCode::FORBIDDEN,
            StorageError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, self.0.to_string()).into_response()
    }
}

/// Storage results as handler results.
fn api<T>(r: Result<T, StorageError>) -> Result<T, Response> { r.map_err(|e| ApiError(e).into_response()) }

#[derive(Serialize)]
struct Health {
    app: &'static str,
    version: &'static str,
    /// null until a folder is chosen
    folder: Option<FolderInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientView {
    pub origin: String,
    pub seconds_ago: u64,
}

/// Everything the app's settings show about the node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusView {
    pub version: String,
    pub address: String,
    pub folder: Option<FolderInfo>,
    pub clients: Vec<ClientView>,
    pub plugins: Vec<PluginView>,
    pub uv: UvState,
    /// whether the app starts on login; absent if it can't
    pub autostart: Option<bool>,
}

#[derive(Serialize)]
struct NoteEntry {
    key: String,
    text: String,
}

async fn health(State(s): State<AppState>) -> Json<Health> {
    Json(Health { app: s.identity.name, version: env!("CARGO_PKG_VERSION"), folder: s.folder().map(|f| f.info.clone()) })
}

async fn worker_access(headers: &HeaderMap, state: &AppState) -> Result<Option<crate::manifest::Access>, Response> {
    let Some(value) = headers.get(header::AUTHORIZATION) else { return Ok(None) };
    let value = value.to_str().map_err(|_| StatusCode::UNAUTHORIZED.into_response())?;
    let token = value.strip_prefix("Bearer ").ok_or_else(|| StatusCode::UNAUTHORIZED.into_response())?;
    state.plugins.policy_for_token(token).await.map(Some).ok_or_else(|| StatusCode::UNAUTHORIZED.into_response())
}

fn readable(gestalts: &gestalts_core::Gestalts, access: &crate::manifest::Access, key: &str, text: &str) -> bool {
    let note = gestalts_core::Note::parse(key, text);
    let gs = gestalts.of(&note);
    access.read.gestalts.iter().any(|g| gs.contains(g)) && access.read.tags_all.iter().all(|t| note.has_tag(t))
}

fn writable(access: &crate::manifest::Access, key: &str, text: &str) -> bool {
    let note = gestalts_core::Note::parse(key, text);
    note.parse_error.is_none() && !access.write.tags_all.is_empty() && access.write.tags_all.iter().all(|t| note.has_tag(t))
}

async fn list_notes(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Vec<NoteEntry>>, Response> {
    let s = state.store()?;
    let access = worker_access(&headers, &state).await?;
    let mut out = Vec::new();
    for key in api(s.list_notes_sync())? {
        if let Some(text) = api(s.read_note_sync(&key))?
            && access.as_ref().is_none_or(|a| readable(state.plugins.gestalts(), a, &key, &text)) {
            out.push(NoteEntry { key, text });
        }
    }
    Ok(Json(out))
}

async fn read_note(State(state): State<AppState>, UrlPath(key): UrlPath<String>, headers: HeaderMap) -> Result<Response, Response> {
    let s = state.store()?;
    let access = worker_access(&headers, &state).await?;
    Ok(match api(s.read_note_sync(&key))? {
        Some(t) if access.as_ref().is_none_or(|a| readable(state.plugins.gestalts(), a, &key, &t)) => ([(header::CONTENT_TYPE, "application/yaml; charset=utf-8")], t).into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    })
}

async fn write_note(State(state): State<AppState>, UrlPath(key): UrlPath<String>, headers: HeaderMap, body: String) -> Result<StatusCode, Response> {
    let s = state.store()?;
    let access = worker_access(&headers, &state).await?;
    if let Some(a) = &access {
        if !writable(a, &key, &body) { return Err(StatusCode::FORBIDDEN.into_response()); }
        if let Some(old) = api(s.read_note_sync(&key))? && !writable(a, &key, &old) { return Err(StatusCode::FORBIDDEN.into_response()); }
    }
    api(s.write_note_sync(&key, &body))?;
    state.plugins.note_changed(&key, &body).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_note(State(state): State<AppState>, UrlPath(key): UrlPath<String>, headers: HeaderMap) -> Result<StatusCode, Response> {
    let s = state.store()?;
    let access = worker_access(&headers, &state).await?;
    if let Some(a) = &access {
        let old = api(s.read_note_sync(&key))?;
        if old.as_ref().is_none_or(|text| !writable(a, &key, text)) { return Err(StatusCode::FORBIDDEN.into_response()); }
    }
    // a delete is a tombstone, so it syncs like any other change (doc/node.md#sync)
    let Some(old) = api(s.read_note_sync(&key))? else { return Ok(StatusCode::NO_CONTENT) };
    if gestalts_core::is_tombstone_text(&old) { return Ok(StatusCode::NO_CONTENT); }
    let id = gestalts_core::Note::parse(key.clone(), old).id().to_owned();
    let tomb = gestalts_core::tombstone(&id, &now_iso());
    api(s.write_note_sync(&key, &tomb))?;
    state.plugins.note_changed(&key, &tomb).await;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) fn now_iso() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    gestalts_core::iso_datetime(ms)
}

/// Blobs referenced by notes this worker may read.
fn referenced_blobs(s: &FsStorage, gestalts: &gestalts_core::Gestalts, access: &crate::manifest::Access) -> Result<std::collections::BTreeSet<String>, Response> {
    let mut names = std::collections::BTreeSet::new();
    if access.blobs.read != crate::manifest::BlobRead::Referenced { return Ok(names); }
    for key in api(s.list_notes_sync())? {
        if let Some(text) = api(s.read_note_sync(&key))? && readable(gestalts, access, &key, &text) {
            names.extend(gestalts_core::Note::parse(key, text).blobs().into_iter().map(|b| b.target));
        }
    }
    Ok(names)
}

async fn list_blobs(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Vec<String>>, Response> {
    let s = state.store()?;
    Ok(Json(match worker_access(&headers, &state).await? {
        Some(access) => referenced_blobs(&s, state.plugins.gestalts(), &access)?.into_iter().collect(),
        None => api(s.list_blobs_sync())?,
    }))
}

async fn read_blob(State(state): State<AppState>, UrlPath(name): UrlPath<String>, headers: HeaderMap) -> Result<Response, Response> {
    let s = state.store()?;
    if let Some(access) = worker_access(&headers, &state).await?
        && !referenced_blobs(&s, state.plugins.gestalts(), &access)?.contains(&name) { return Err(StatusCode::NOT_FOUND.into_response()); }
    Ok(match api(s.read_blob_sync(&name))? {
        Some(b) => ([(header::CONTENT_TYPE, mime_guess::from_path(&name).first_or_octet_stream().to_string())], b).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    })
}

async fn write_blob(State(state): State<AppState>, UrlPath(name): UrlPath<String>, headers: HeaderMap, body: Bytes) -> Result<StatusCode, Response> {
    let s = state.store()?;
    if worker_access(&headers, &state).await?.is_some_and(|a| !a.blobs.write) { return Err(StatusCode::FORBIDDEN.into_response()); }
    api(s.write_blob_sync(&name, &body))?;
    Ok(StatusCode::NO_CONTENT)
}

/// Apps only: workers never delete blobs. Deleting one a note still uses is the caller's mistake to avoid.
async fn delete_blob(State(state): State<AppState>, UrlPath(name): UrlPath<String>, headers: HeaderMap) -> Result<StatusCode, Response> {
    let s = state.store()?;
    if worker_access(&headers, &state).await?.is_some() { return Err(StatusCode::FORBIDDEN.into_response()); }
    api(s.delete_blob_sync(&name))?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
struct Collected { deleted: Vec<String> }

/// Collects the folder's unreferenced blobs (`gestalts_core::blobs`); an app calls it after each successful sync.
/// The manifest of what has been unreferenced since when is `.gestalts/blob-gc.json`.
async fn collect_blobs(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Collected>, Response> {
    let s = state.store()?;
    if worker_access(&headers, &state).await?.is_some() { return Err(StatusCode::FORBIDDEN.into_response()); }
    let plugins = state.plugins.clone();
    let deleted = tokio::task::spawn_blocking(move || collect_folder(&s, plugins.gestalts()))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())?;
    Ok(Json(Collected { deleted: api(deleted)? }))
}

fn collect_folder(s: &FsStorage, gestalts: &gestalts_core::Gestalts) -> gestalts_core::storage::Result<Vec<String>> {
    let mut notes = Vec::new();
    for key in s.list_notes_sync()? {
        if let Some(text) = s.read_note_sync(&key)? {
            notes.push((key, text));
        }
    }
    let referenced = gestalts_core::referenced_blobs(notes.iter().map(|(k, t)| (k.as_str(), t.as_str())), gestalts);
    let file = s.root().join(".gestalts").join("blob-gc.json");
    let mut manifest: gestalts_core::GcManifest = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    let deleted = pollster::block_on(gestalts_core::collect_blobs(s, &referenced, &mut manifest, now))?;
    let json = serde_json::to_vec_pretty(&manifest).map_err(|e| StorageError::Io(e.to_string()))?;
    crate::paths::write_atomic(&file, &json).map_err(|e| StorageError::Io(e.to_string()))?;
    Ok(deleted)
}

async fn list_plugins(State(s): State<AppState>) -> Json<Vec<PluginView>> { Json(s.plugins.views().await) }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunStarted { run_id: String }

async fn run_plugin(State(s): State<AppState>, UrlPath(id): UrlPath<String>) -> Result<Json<RunStarted>, (StatusCode, String)> {
    s.plugins.run(&id).await.map(|run_id| Json(RunStarted { run_id })).map_err(|e| (StatusCode::CONFLICT, e))
}

#[derive(Serialize)]
struct ServiceView { id: String, available: bool }

async fn list_services(State(s): State<AppState>) -> Json<Vec<ServiceView>> {
    Json(s.plugins.services().await.into_iter().map(|(id, available)| ServiceView { id, available }).collect())
}

/// How long a service may take to answer (a Typst compile, an OCR run) before the app gets a 504.
const SERVICE_TIMEOUT: Duration = Duration::from_secs(30);

async fn proxy_service(State(s): State<AppState>, UrlPath((service, path)): UrlPath<(String, String)>, method: Method,
    uri: axum::http::Uri, headers: HeaderMap, body: Bytes) -> Response {
    let Some(base) = s.plugins.service_url(&service).await else { return StatusCode::SERVICE_UNAVAILABLE.into_response() };
    let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    let mut request = s.plugins.client().request(method, format!("{base}/services/{service}/{path}{query}")).timeout(SERVICE_TIMEOUT).body(body);
    if let Some(value) = headers.get(header::CONTENT_TYPE) { request = request.header(header::CONTENT_TYPE, value); }
    match request.send().await {
        Ok(r) => {
            let status = r.status();
            let content_type = r.headers().get(header::CONTENT_TYPE).cloned();
            match r.bytes().await {
                Ok(bytes) => {
                    let mut response = (status, bytes).into_response();
                    if let Some(value) = content_type { response.headers_mut().insert(header::CONTENT_TYPE, value); }
                    response
                }
                Err(e) => (StatusCode::BAD_GATEWAY, e.to_string()).into_response(),
            }
        }
        Err(e) if e.is_timeout() => (StatusCode::GATEWAY_TIMEOUT, format!("{service} took longer than {}s", SERVICE_TIMEOUT.as_secs())).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, e.to_string()).into_response(),
    }
}

// --- control: the embedding app's own UI (its token) or its web frontend served by this node (its own origin) ---

/// Whether a request comes from a page this node served: its `Origin` is the address it was sent to, or, for a GET
/// (which browsers send without `Origin` to their own origin), the browser says it is same-origin. The host check
/// (`local_host_only`) already made sure that address is this machine.
fn same_origin(headers: &HeaderMap) -> bool {
    let value = |name| headers.get(name).and_then(|v: &HeaderValue| v.to_str().ok());
    match value(header::ORIGIN) {
        Some(origin) => value(header::HOST).is_some_and(|h| origin.strip_prefix("http://") == Some(h)),
        None => value(SEC_FETCH_SITE) == Some("same-origin"),
    }
}

const SEC_FETCH_SITE: header::HeaderName = header::HeaderName::from_static("sec-fetch-site");

async fn control_auth(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    if !same_origin(headers) {
        // any other web page is refused, whatever it sends
        if headers.contains_key(header::ORIGIN) { return StatusCode::FORBIDDEN.into_response(); }
        let token = headers.get(CONTROL_HEADER).and_then(|v| v.to_str().ok());
        if token != Some(&*state.control_token) { return StatusCode::UNAUTHORIZED.into_response(); }
    }
    next.run(request).await
}

async fn control_status(State(s): State<AppState>) -> Json<StatusView> {
    let plugins = s.plugins.views().await;
    Json(s.status(plugins))
}

#[derive(Deserialize)]
pub struct ChooseFolder { pub path: String }

async fn control_folder(State(s): State<AppState>, Json(req): Json<ChooseFolder>) -> Result<Json<StatusView>, (StatusCode, String)> {
    open_folder(&s, Path::new(&req.path))?;
    Ok(control_status(State(s)).await)
}

/// Opens, remembers and serves `path`, and tells the app and every `/events` client.
fn open_folder(s: &AppState, path: &Path) -> Result<(), (StatusCode, String)> {
    let folder = Folder::open(path).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let info = folder.info.clone();
    if let Some(paths) = &s.remember_in {
        let mut config = Config::load(paths);
        config.folder = Some(info.path.clone().into());
        config.save(paths).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("cannot save the config: {e}")))?;
    }
    s.set_folder(folder);
    s.shell.folder_changed(Some(&info));
    s.events.send(Event::Folder(Some(info)));
    Ok(())
}

/// The app's folder picker; the status as it is afterwards, whether or not the user picked one.
async fn control_choose_folder(State(s): State<AppState>) -> Result<Json<StatusView>, (StatusCode, String)> {
    let shell = s.shell.clone();
    let picked = tokio::task::spawn_blocking(move || shell.choose_folder()).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if let Some(path) = picked { open_folder(&s, &path)?; }
    Ok(control_status(State(s)).await)
}

async fn control_reveal(State(s): State<AppState>) -> Result<StatusCode, (StatusCode, String)> {
    let folder = s.folder().ok_or((StatusCode::CONFLICT, "no folder open".to_owned()))?;
    s.shell.reveal(Path::new(&folder.info.path)).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct Autostart { on: bool }

async fn control_autostart(State(s): State<AppState>, Json(req): Json<Autostart>) -> Result<Json<StatusView>, (StatusCode, String)> {
    s.shell.set_autostart(req.on).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(control_status(State(s)).await)
}

async fn control_show(State(s): State<AppState>) -> StatusCode {
    s.shell.show();
    StatusCode::NO_CONTENT
}

async fn control_quit(State(s): State<AppState>) -> StatusCode {
    s.shell.quit();
    StatusCode::NO_CONTENT
}

// --- events ---

/// `/events`: a WebSocket of `watch::Event`s as JSON. A WebSocket rather than server-sent events, because browsers
/// allow only six HTTP/1.1 connections per host, and each open tab would hold one.
async fn events(State(s): State<AppState>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    // CORS doesn't cover WebSockets: only the web apps allowed to use the API may listen
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok())
        && !origin_allowed(origin, &s.extra_origins) && !same_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()).map(str::to_owned);
    ws.on_upgrade(move |socket| send_events(s, socket, origin))
}

async fn send_events(s: AppState, mut socket: WebSocket, origin: Option<String>) {
    let mut rx = s.events.subscribe();
    let mut ping = tokio::time::interval(EVENTS_PING);
    loop {
        let event = tokio::select! {
            e = rx.recv() => match e {
                Ok(e) => e,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => Event::Reload,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            },
            m = socket.recv() => match m {
                // a Close too: reading on sends the close reply (else the browser sees an abnormal closure), then ends
                Some(Ok(_)) => continue,
                Some(Err(_)) | None => return,
            },
            _ = ping.tick() => {
                // an open socket is a connected client
                if let Some(o) = &origin { s.clients.lock().expect("clients lock").insert(o.clone(), Instant::now()); }
                if socket.send(Message::Ping(Bytes::new())).await.is_err() { return; }
                continue;
            }
        };
        let json = serde_json::to_string(&event).expect("events serialize");
        if socket.send(Message::Text(json.into())).await.is_err() { return; }
    }
}

// --- the app's web frontend ---

async fn app_file(State(s): State<AppState>, uri: axum::http::Uri) -> Response {
    let Some(app) = &s.identity.app else { return StatusCode::NOT_FOUND.into_response() };
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let Some(bytes) = app.read(path) else { return StatusCode::NOT_FOUND.into_response() };
    // hashed build output never changes; everything else (index.html, decks) may with the next version
    let cache = if path.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    let mime = mime_guess::from_path(path).first_or_octet_stream().to_string();
    ([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, cache.to_owned())], bytes.into_owned()).into_response()
}

/// Remembers which (allowed) web frontends talk to us, for the app's settings.
async fn track_origin(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if let Some(origin) = request.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok())
        && origin_allowed(origin, &state.extra_origins) {
        state.clients.lock().expect("clients lock").insert(origin.to_owned(), Instant::now());
    }
    next.run(request).await
}

/// Refuses requests for any host name but this machine's. A web page on another domain that later resolves to
/// 127.0.0.1 (DNS rebinding) would otherwise be same-origin with the API. Requests without `Host` aren't from a
/// browser.
async fn local_host_only(request: Request, next: Next) -> Response {
    if let Some(host) = request.headers().get(header::HOST) {
        let host = host.to_str().unwrap_or_default();
        let name = if host.starts_with('[') { host.split_inclusive(']').next().unwrap_or_default() } else { host.split(':').next().unwrap_or_default() };
        if !matches!(name, "localhost" | "127.0.0.1" | "[::1]") { return StatusCode::FORBIDDEN.into_response(); }
    }
    next.run(request).await
}

pub fn is_local_origin(origin: &str) -> bool {
    let rest = origin.strip_prefix("http://").or_else(|| origin.strip_prefix("https://"));
    rest.is_some_and(|r| {
        let host = r.rsplit_once(':').map_or(r, |(h, _)| h);
        matches!(host, "localhost" | "127.0.0.1" | "[::1]")
    })
}

/// Allowed web origins: localhost and `extra` (the app's own frontends, the config's and `--allow-origin`).
pub fn origin_allowed(origin: &str, extra: &[String]) -> bool {
    is_local_origin(origin) || extra.iter().any(|e| e == origin)
}

pub fn app(state: AppState) -> Router {
    let extra_origins = state.extra_origins.clone();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin: &HeaderValue, _| origin.to_str().is_ok_and(|o| origin_allowed(o, &extra_origins))))
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any)
        .allow_private_network(true);
    let control = Router::new()
        .route("/status", get(control_status))
        .route("/folder", post(control_folder))
        .route("/choose-folder", post(control_choose_folder))
        .route("/reveal", post(control_reveal))
        .route("/autostart", put(control_autostart))
        .route("/show", post(control_show))
        .route("/quit", post(control_quit))
        .route_layer(middleware::from_fn_with_state(state.clone(), control_auth));
    Router::new()
        .route("/health", get(health))
        .route("/events", get(events))
        .route("/notes", get(list_notes))
        .route("/notes/{key}", get(read_note).put(write_note).delete(delete_note))
        .route("/blobs", get(list_blobs))
        .route("/blobs/collect", post(collect_blobs))
        .route("/blobs/{name}", get(read_blob).put(write_blob).delete(delete_blob))
        .route("/plugins", get(list_plugins))
        .route("/plugins/{id}/runs", post(run_plugin))
        .route("/services", get(list_services))
        .route("/services/{service}/{*path}", any(proxy_service))
        .nest("/control", control)
        .fallback(get(app_file))
        .layer(middleware::from_fn_with_state(state.clone(), track_origin))
        .layer(DefaultBodyLimit::max(512 * 1024 * 1024))
        .layer(cors)
        .layer(middleware::from_fn(local_host_only))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use tower::ServiceExt;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("gestalts-test-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn state(folder: Option<Folder>) -> AppState { state_with(folder, None) }

    fn state_with(folder: Option<Folder>, app: Option<AppFiles>) -> AppState {
        let root = temp_dir("paths");
        let paths = Paths { config: root.join("config"), data: root.join("data"), cache: root.join("cache") };
        let plugins = PluginHost::discover(&[], "http://127.0.0.1:0".into(), paths.clone()).unwrap();
        AppState::new(folder, plugins, "secret".into(), Some(paths), Arc::new(Headless), Identity { name: "test", app },
                      "http://127.0.0.1:0".into(), vec![APP_ORIGIN.into()])
    }

    /// the frontend of the app embedding the node
    const APP_ORIGIN: &str = "https://app.example";

    async fn send(app: &Router, request: axum::http::Request<Body>) -> (StatusCode, String) {
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    fn get_req(uri: &str) -> axum::http::Request<Body> { axum::http::Request::get(uri).body(Body::empty()).unwrap() }

    #[test]
    fn local_origins() {
        assert!(is_local_origin("http://localhost:5173"));
        assert!(is_local_origin("http://127.0.0.1:4173"));
        assert!(!is_local_origin("https://evil.example"));
        assert!(!is_local_origin("http://localhost.evil.example:80"));
    }

    #[test]
    fn allowed_origins() {
        let app = ["https://gestalter.koljasam.com".to_string()];
        assert!(origin_allowed("https://gestalter.koljasam.com", &app));
        assert!(!origin_allowed("https://gestalter.koljasam.com", &[]));
        assert!(!origin_allowed("https://gestalter.koljasam.com.evil.example", &app));
        assert!(!origin_allowed("http://gestalter.koljasam.com", &app));
        assert!(origin_allowed("https://mine.example", &["https://mine.example".into()]));
    }

    #[test]
    fn folder_id_is_created_once() {
        let dir = temp_dir("folder");
        let a = Folder::open(&dir).unwrap();
        let b = Folder::open(&dir).unwrap();
        assert_eq!(a.info.id, b.info.id);
        assert!(dir.join("notes").is_dir() && dir.join("blobs").is_dir());
        assert_ne!(a.info.id, Folder::open(&temp_dir("other")).unwrap().info.id);
    }

    #[tokio::test]
    async fn no_folder_means_conflict_not_empty() {
        let app = app(state(None));
        assert_eq!(send(&app, get_req("/notes")).await.0, StatusCode::CONFLICT);
        let (status, body) = send(&app, get_req("/health")).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"folder\":null"), "{body}");
    }

    #[tokio::test]
    async fn control_needs_token_and_no_origin() {
        let app = app(state(None));
        assert_eq!(send(&app, get_req("/control/status")).await.0, StatusCode::UNAUTHORIZED);
        let with_origin = axum::http::Request::get("/control/status").header(CONTROL_HEADER, "secret")
            .header(header::ORIGIN, "http://localhost:5173").body(Body::empty()).unwrap();
        assert_eq!(send(&app, with_origin).await.0, StatusCode::FORBIDDEN);
        let ok = axum::http::Request::get("/control/status").header(CONTROL_HEADER, "secret").body(Body::empty()).unwrap();
        assert_eq!(send(&app, ok).await.0, StatusCode::OK);
    }

    #[tokio::test]
    async fn the_served_app_may_use_control_other_pages_may_not() {
        let app = app(state(None));
        let from = |origin: &str, host: &str| axum::http::Request::get("/control/status").header(header::ORIGIN, origin)
            .header(header::HOST, host).body(Body::empty()).unwrap();
        assert_eq!(send(&app, from("http://127.0.0.1:7717", "127.0.0.1:7717")).await.0, StatusCode::OK);
        let fetch_site = |site: &str| axum::http::Request::get("/control/status").header("sec-fetch-site", site)
            .header(header::HOST, "127.0.0.1:7717").body(Body::empty()).unwrap();
        assert_eq!(send(&app, fetch_site("same-origin")).await.0, StatusCode::OK);
        assert_eq!(send(&app, fetch_site("cross-site")).await.0, StatusCode::UNAUTHORIZED);
        assert_eq!(send(&app, from("http://localhost:5173", "127.0.0.1:7717")).await.0, StatusCode::FORBIDDEN);
        assert_eq!(send(&app, from(APP_ORIGIN, "127.0.0.1:7717")).await.0, StatusCode::FORBIDDEN);
        // DNS rebinding: same origin, but not our host name
        assert_eq!(send(&app, from("http://evil.example:7717", "evil.example:7717")).await.0, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn only_this_machine_s_host_names() {
        let app = app(state(None));
        let to = |host: &str| axum::http::Request::get("/health").header(header::HOST, host).body(Body::empty()).unwrap();
        for host in ["127.0.0.1:7717", "localhost:7717", "[::1]:7717", "localhost"] {
            assert_eq!(send(&app, to(host)).await.0, StatusCode::OK, "{host}");
        }
        for host in ["evil.example:7717", "localhost.evil.example", "127.0.0.1.nip.io:7717"] {
            assert_eq!(send(&app, to(host)).await.0, StatusCode::FORBIDDEN, "{host}");
        }
    }

    #[tokio::test]
    async fn serves_the_app_s_files() {
        let dist = temp_dir("dist");
        std::fs::create_dir_all(dist.join("assets")).unwrap();
        std::fs::write(dist.join("index.html"), "<!doctype html>").unwrap();
        std::fs::write(dist.join("assets/core-1a2b.wasm"), [0, 97, 115, 109]).unwrap();
        let app = app(state_with(None, Some(AppFiles::Disk(dist))));
        let response = app.clone().oneshot(get_req("/")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "text/html");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
        let response = app.clone().oneshot(get_req("/assets/core-1a2b.wasm")).await.unwrap();
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/wasm");
        assert!(response.headers()[header::CACHE_CONTROL].to_str().unwrap().contains("immutable"));
        assert_eq!(send(&app, get_req("/missing.js")).await.0, StatusCode::NOT_FOUND);
        assert_eq!(send(&app, get_req("/assets/../../etc/passwd")).await.0, StatusCode::NOT_FOUND);
        // the API is still there
        assert_eq!(send(&app, get_req("/health")).await.0, StatusCode::OK);
        // without an app nothing is served
        assert_eq!(send(&self::app(state(None)), get_req("/")).await.0, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn changes_go_out_as_events() {
        let dir = temp_dir("events");
        let s = state(Some(Folder::open(&dir).unwrap()));
        let mut rx = s.events.subscribe();
        let app = app(s.clone());
        let put = axum::http::Request::put("/notes/through-api").body(Body::from("id: through-api\n")).unwrap();
        assert_eq!(send(&app, put).await.0, StatusCode::NO_CONTENT);
        let next = |rx: &mut tokio::sync::broadcast::Receiver<Event>| {
            let mut rx = rx.resubscribe();
            async move { tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("an event in time").unwrap() }
        };
        let got = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("an event in time").unwrap();
        assert_eq!(got, Event::Changed { notes: vec!["through-api".into()], blobs: vec![] });
        let waiting = next(&mut rx);
        std::fs::write(dir.join("notes/by-hand.yml"), "id: by-hand\n").unwrap();
        std::fs::write(dir.join("blobs/pic.png"), [1]).unwrap();
        std::fs::write(dir.join("notes/.ignored.yml.tmp"), "x").unwrap();
        assert_eq!(waiting.await, Event::Changed { notes: vec!["by-hand".into()], blobs: vec!["pic.png".into()] });

        let other = temp_dir("events-other");
        let waiting = next(&mut rx);
        open_folder(&s, &other).unwrap();
        assert!(matches!(waiting.await, Event::Folder(Some(_))));
        let waiting = next(&mut rx);
        std::fs::write(other.join("notes/in-other.yml"), "id: in-other\n").unwrap();
        assert_eq!(waiting.await, Event::Changed { notes: vec!["in-other".into()], blobs: vec![] });
    }

    #[tokio::test]
    async fn choosing_a_folder_serves_it_and_remembers_it() {
        let s = state(None);
        let paths = s.remember_in.clone().unwrap();
        let app = app(s);
        let dir = temp_dir("chosen");
        std::fs::create_dir_all(dir.join("notes")).unwrap();
        std::fs::write(dir.join("notes/a.yml"), "title: A\n").unwrap();
        let choose = axum::http::Request::post("/control/folder").header(CONTROL_HEADER, "secret")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::json!({ "path": dir }).to_string())).unwrap();
        assert_eq!(send(&app, choose).await.0, StatusCode::OK);
        let (status, body) = send(&app, get_req("/notes")).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("title: A"), "{body}");
        assert_eq!(Config::load(&paths).folder.unwrap(), dir.canonicalize().unwrap());
    }

    #[tokio::test]
    async fn frontends_are_tracked() {
        let s = state(None);
        let app = app(s.clone());
        let req = axum::http::Request::get("/health").header(header::ORIGIN, APP_ORIGIN).body(Body::empty()).unwrap();
        send(&app, req).await;
        let rejected = axum::http::Request::get("/health").header(header::ORIGIN, "https://evil.example").body(Body::empty()).unwrap();
        send(&app, rejected).await;
        let status = s.status(vec![]);
        assert_eq!(status.clients.len(), 1);
        assert_eq!(status.clients[0].origin, APP_ORIGIN);
    }

    #[tokio::test]
    async fn deletes_are_tombstones_and_blobs_are_collected_later() {
        let dir = temp_dir("gc");
        let app = app(state(Some(Folder::open(&dir).unwrap())));
        std::fs::write(dir.join("notes/a.yml"), "id: a\nblobs: [used.png]\n").unwrap();
        std::fs::write(dir.join("blobs/used.png"), [1]).unwrap();
        std::fs::write(dir.join("blobs/unused.png"), [2]).unwrap();
        let del = axum::http::Request::delete("/notes/a").body(Body::empty()).unwrap();
        assert_eq!(send(&app, del).await.0, StatusCode::NO_CONTENT);
        assert!(gestalts_core::is_tombstone_text(&std::fs::read_to_string(dir.join("notes/a.yml")).unwrap()));
        let collect = || axum::http::Request::post("/blobs/collect").body(Body::empty()).unwrap();
        let (status, body) = send(&app, collect()).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"deleted\":[]"), "too soon: {body}");
        assert!(std::fs::read_to_string(dir.join(".gestalts/blob-gc.json")).unwrap().contains("unused.png"));
        let del = axum::http::Request::delete("/blobs/unused.png").body(Body::empty()).unwrap();
        assert_eq!(send(&app, del).await.0, StatusCode::NO_CONTENT);
        assert!(!dir.join("blobs/unused.png").exists());
    }

    /// The node API as another device sees it: `gestalts_peer::Peer` over real HTTP, syncing with the folder.
    #[tokio::test]
    async fn a_peer_syncs_with_the_folder() {
        use gestalts_core::{Gestalts, Memory, Storage};
        use gestalts_peer::Peer;

        let dir = temp_dir("peer");
        let app = app(state(Some(Folder::open(&dir).unwrap())));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        std::fs::write(dir.join("notes/on-disk.yml"), "id: on-disk\nblobs: [disk.png]\n").unwrap();
        std::fs::write(dir.join("blobs/disk.png"), [1, 2]).unwrap();

        let peer = Peer::new(&url);
        let health = peer.health().await.unwrap();
        assert_eq!(health["folder"]["path"].as_str().map(Path::new), Some(dir.canonicalize().unwrap().as_path()));

        let local = Memory::default();
        local.write_note("on-phone", "id: on-phone\nblobs: [phone.png]\n").await.unwrap();
        local.write_blob("phone.png", &[3]).await.unwrap();
        let base = Memory::default();
        let report = gestalts_core::sync_with(&local, &peer, &base, &Gestalts::builtin(), "2026-01-01T00:00:00Z", &mut |_| {}).await.unwrap();
        assert_eq!(report.pulled, ["on-disk"]);
        assert_eq!(report.pushed, ["on-phone"]);
        assert_eq!((report.blobs_pulled, report.blobs_pushed), (vec!["disk.png".to_owned()], vec!["phone.png".to_owned()]));
        assert!(std::fs::read_to_string(dir.join("notes/on-phone.yml")).unwrap().contains("phone.png"));
        assert_eq!(local.read_note("on-disk").await.unwrap().unwrap(), "id: on-disk\nblobs: [disk.png]\n");
        assert_eq!(std::fs::read(dir.join("blobs/phone.png")).unwrap(), [3]);
        assert_eq!(local.read_blob("disk.png").await.unwrap().unwrap(), [1, 2]);

        assert_eq!(peer.read_note("missing").await.unwrap(), None);
        peer.delete_note("on-phone").await.unwrap();
        assert!(gestalts_core::is_tombstone_text(&peer.read_note("on-phone").await.unwrap().unwrap()));
    }
}
