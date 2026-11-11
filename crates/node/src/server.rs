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

use crate::lan::{Lan, LanView};
use crate::llm::{Llm, SettingsChange};
use crate::net::Net;
use crate::pairing::{DeviceView, Offer, Refused};
use crate::paths::{Config, Paths};
use crate::manifest::AccessPolicy;
use crate::plugins::{PluginHost, PluginView};
use crate::uv::UvState;
use crate::watch::{Event, Events};

/// Header carrying the per-run control token (see `paths::Paths::control_token_file`).
pub const CONTROL_HEADER: &str = "x-gestalts-control";
/// A frontend counts as connected if it made a request this recently (they sync every 15 s, and an open `/events`
/// socket counts every 20 s).
const CONNECTED_FOR: Duration = Duration::from_secs(60);
const EVENTS_PING: Duration = Duration::from_secs(20);
/// What `.gestalts/format` says in a data folder of ymls that each name one gestalt.
const FOLDER_FORMAT: &str = "1";

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
    /// Opens (and if needed creates) a data folder with `notes/`, `blobs/` and `.gestalts/folder-id`. Refuses a folder
    /// that holds ymls but isn't marked as one of ours in this format: opening it would mean treating every file in it
    /// as invalid, and syncing that to other devices.
    pub fn open(path: &Path) -> Result<Folder, String> {
        let marker = path.join(".gestalts").join("format");
        match std::fs::read_to_string(&marker) {
            Ok(format) if format.trim() == FOLDER_FORMAT => {}
            Ok(format) => return Err(format!("{} is in format {}, this app needs {FOLDER_FORMAT}", path.display(), format.trim())),
            Err(_) => {
                let holds_ymls = std::fs::read_dir(path.join("notes")).is_ok_and(|mut d| d.any(|e| e.is_ok_and(|e| e.path().extension().is_some_and(|x| x == "yml"))));
                if holds_ymls {
                    return Err(format!("{} holds files from before this format; choose a new, empty folder", path.display()));
                }
                crate::paths::write_atomic(&marker, FOLDER_FORMAT.as_bytes()).map_err(|e| format!("cannot write {}: {e}", marker.display()))?;
            }
        }
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
    /// the home network: paired devices, and the listener for them
    lan: Option<Arc<Lan>>,
    /// HTTP for views, to the hosts plugins declare
    net: Net,
    /// completions for views, from the user's providers
    llm: Arc<Llm>,
}

impl AppState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(folder: Option<Folder>, plugins: PluginHost, control_token: String, remember_in: Option<Paths>,
               shell: Arc<dyn Shell>, identity: Identity, address: String, extra_origins: Vec<String>) -> Self {
        let net = Net::new(plugins.network_hosts());
        let llm = Arc::new(Llm::load(plugins.config_dir()));
        let state = AppState { folder: Arc::default(), watcher: Arc::default(), events: Events::default(), plugins, clients: Arc::default(),
                               control_token: control_token.into(), remember_in, shell, identity, address, extra_origins: extra_origins.into(), lan: None, net, llm };
        if let Some(f) = folder { state.set_folder(f); }
        state
    }

    /// Lets devices on the home network pair with this node and sync with it.
    pub fn with_lan(mut self, lan: Arc<Lan>) -> Self {
        self.lan = Some(lan);
        self
    }

    pub fn lan(&self) -> Option<&Arc<Lan>> { self.lan.as_ref() }

    fn folder(&self) -> Option<Arc<Folder>> { self.folder.read().expect("folder lock").clone() }

    /// Serves `folder` from now on and watches it for changes.
    fn set_folder(&self, folder: Folder) {
        let watcher = self.events.watch(Path::new(&folder.info.path));
        *self.watcher.lock().expect("watcher lock") = watcher;
        *self.folder.write().expect("folder lock") = Some(Arc::new(folder));
    }

    fn store(&self) -> Result<Arc<FsStorage>, Response> {
        self.folder().map(|f| f.store.clone())
            .ok_or_else(|| (StatusCode::CONFLICT, "no folder open; choose one in the gestalter desktop app").into_response())
    }

    fn status(&self, plugins: Vec<PluginView>) -> StatusView {
        let now = Instant::now();
        let clients = self.clients.lock().expect("clients lock").iter()
            .filter(|(_, seen)| now.duration_since(**seen) < CONNECTED_FOR)
            .map(|(origin, seen)| ClientView { origin: origin.clone(), seconds_ago: now.duration_since(*seen).as_secs() })
            .collect();
        StatusView { version: env!("CARGO_PKG_VERSION").into(), address: self.address.clone(), folder: self.folder().map(|f| f.info.clone()),
                     clients, plugins, uv: self.plugins.uv_state(), autostart: self.shell.autostart(),
                     lan: self.lan.as_ref().map(|l| l.view()), devices: self.lan.as_ref().map(|l| l.pairing.devices()).unwrap_or_default() }
    }
}

struct ApiError(StorageError);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self.0 {
            StorageError::InvalidKey(_) => StatusCode::BAD_REQUEST,
            StorageError::ReadOnly => StatusCode::FORBIDDEN,
            StorageError::Rejected(_) => StatusCode::UNPROCESSABLE_ENTITY,
            StorageError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, self.0.to_string()).into_response()
    }
}

/// Storage results as handler results.
fn api<T>(r: Result<T, StorageError>) -> Result<T, Response> { r.map_err(|e| ApiError(e).into_response()) }

/// The node API's version, in `/health`: a peer checks it before it syncs.
pub const API_VERSION: u32 = 3;

#[derive(Serialize)]
struct Health {
    app: &'static str,
    version: &'static str,
    api: u32,
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
    /// the home network; absent if this node doesn't pair
    #[serde(default)]
    pub lan: Option<LanView>,
    #[serde(default)]
    pub devices: Vec<DeviceView>,
}

#[derive(Serialize, Deserialize)]
struct YmlEntry {
    id: String,
    text: String,
}

async fn health(State(s): State<AppState>) -> Json<Health> {
    Json(Health { app: s.identity.name, version: env!("CARGO_PKG_VERSION"), api: API_VERSION, folder: s.folder().map(|f| f.info.clone()) })
}

async fn backend_access(headers: &HeaderMap, state: &AppState) -> Result<Option<AccessPolicy>, Response> {
    let Some(value) = headers.get(header::AUTHORIZATION) else { return Ok(None) };
    let value = value.to_str().map_err(|_| StatusCode::UNAUTHORIZED.into_response())?;
    let token = value.strip_prefix("Bearer ").ok_or_else(|| StatusCode::UNAUTHORIZED.into_response())?;
    state.plugins.policy_for_token(token).await.map(Some).ok_or_else(|| StatusCode::UNAUTHORIZED.into_response())
}

async fn read_yml(State(state): State<AppState>, UrlPath(id): UrlPath<String>, headers: HeaderMap) -> Result<Response, Response> {
    let s = state.store()?;
    let access = backend_access(&headers, &state).await?;
    Ok(match api(s.read_yml_sync(&id))? {
        Some(t) if access.as_ref().is_none_or(|a| a.can_read(&id, &t, state.plugins.gestalts())) => ([(header::CONTENT_TYPE, "application/yaml; charset=utf-8")], t).into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    })
}

/// An existing yml a backend may replace or delete: none, a tombstone, or one of a gestalt it writes.
fn may_replace(a: &AccessPolicy, id: &str, old: Option<&str>, g: &gestalts_core::Gestalts) -> bool {
    old.is_none_or(|t| gestalts_core::is_tombstone_text(t) || a.can_write(id, t, g))
}

async fn write_yml(State(state): State<AppState>, UrlPath(id): UrlPath<String>, headers: HeaderMap, body: String) -> Result<StatusCode, Response> {
    let s = state.store()?;
    if let Some(a) = backend_access(&headers, &state).await? {
        let g = state.plugins.gestalts();
        let old = api(s.read_yml_sync(&id))?;
        if !a.can_write(&id, &body, g) || !may_replace(&a, &id, old.as_deref(), g) { return Err(StatusCode::FORBIDDEN.into_response()); }
    }
    api(s.write_yml_sync(&id, &body))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_yml(State(state): State<AppState>, UrlPath(id): UrlPath<String>, headers: HeaderMap) -> Result<StatusCode, Response> {
    let s = state.store()?;
    let Some(old) = api(s.read_yml_sync(&id))? else { return Ok(StatusCode::NO_CONTENT) };
    if let Some(a) = backend_access(&headers, &state).await?
        && !may_replace(&a, &id, Some(&old), state.plugins.gestalts()) { return Err(StatusCode::FORBIDDEN.into_response()); }
    // a delete is a tombstone, so it syncs like any other change
    if !gestalts_core::is_tombstone_text(&old) {
        api(s.write_yml_sync(&id, &gestalts_core::tombstone(&id, &now_iso())))?;
    }
    Ok(StatusCode::NO_CONTENT)
}

// --- sync: what a syncing app reads and writes, so it fetches only the ymls that differ ---

/// Apps only: a backend reads and writes through `/ymls`, where its access is checked.
async fn app_only(headers: &HeaderMap, state: &AppState) -> Result<(), Response> {
    match backend_access(headers, state).await? {
        Some(_) => Err(StatusCode::FORBIDDEN.into_response()),
        None => Ok(()),
    }
}

/// Runs blocking file work off the async threads.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, StorageError> + Send + 'static) -> Result<T, Response> {
    let r = tokio::task::spawn_blocking(f).await.map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())?;
    api(r)
}

/// `{id: hash}` of every yml, reading only the files that changed since the last call.
async fn sync_hashes(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<gestalts_core::Hashes>, Response> {
    let s = state.store()?;
    app_only(&headers, &state).await?;
    Ok(Json(blocking(move || s.yml_hashes_sync()).await?))
}

#[derive(Deserialize)]
struct Ids { ids: Vec<String> }

/// The given ymls that exist.
async fn sync_read(State(state): State<AppState>, headers: HeaderMap, Json(req): Json<Ids>) -> Result<Json<Vec<YmlEntry>>, Response> {
    let s = state.store()?;
    app_only(&headers, &state).await?;
    Ok(Json(blocking(move || {
        let mut out = Vec::new();
        for id in req.ids {
            if let Some(text) = s.read_yml_sync(&id)? { out.push(YmlEntry { id, text }); }
        }
        Ok(out)
    }).await?))
}

/// Writes several ymls.
async fn sync_write(State(state): State<AppState>, headers: HeaderMap, Json(ymls): Json<Vec<YmlEntry>>) -> Result<StatusCode, Response> {
    let s = state.store()?;
    app_only(&headers, &state).await?;
    blocking(move || {
        for y in &ymls { s.write_yml_sync(&y.id, &y.text)?; }
        Ok(())
    }).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) fn now_iso() -> String {
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    gestalts_core::iso_datetime(ms)
}

async fn list_blobs(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Vec<String>>, Response> {
    let s = state.store()?;
    if backend_access(&headers, &state).await?.is_some_and(|a| !a.can_read_blobs()) { return Err(StatusCode::FORBIDDEN.into_response()); }
    Ok(Json(api(s.list_blobs_sync())?))
}

async fn read_blob(State(state): State<AppState>, UrlPath(name): UrlPath<String>, headers: HeaderMap) -> Result<Response, Response> {
    let s = state.store()?;
    if backend_access(&headers, &state).await?.is_some_and(|a| !a.can_read_blobs()) { return Err(StatusCode::NOT_FOUND.into_response()); }
    Ok(match api(s.read_blob_sync(&name))? {
        Some(b) => ([(header::CONTENT_TYPE, mime_guess::from_path(&name).first_or_octet_stream().to_string())], b).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    })
}

async fn write_blob(State(state): State<AppState>, UrlPath(name): UrlPath<String>, headers: HeaderMap, body: Bytes) -> Result<StatusCode, Response> {
    let s = state.store()?;
    if backend_access(&headers, &state).await?.is_some_and(|a| !a.can_write_blobs()) { return Err(StatusCode::FORBIDDEN.into_response()); }
    api(s.write_blob_sync(&name, &body))?;
    Ok(StatusCode::NO_CONTENT)
}

/// Apps only: backends never delete blobs. Deleting one a yml still uses is the caller's mistake to avoid.
async fn delete_blob(State(state): State<AppState>, UrlPath(name): UrlPath<String>, headers: HeaderMap) -> Result<StatusCode, Response> {
    let s = state.store()?;
    if backend_access(&headers, &state).await?.is_some() { return Err(StatusCode::FORBIDDEN.into_response()); }
    api(s.delete_blob_sync(&name))?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
struct Collected { deleted: Vec<String> }

/// Collects the folder's unreferenced blobs (`gestalts_core::blobs`); an app calls it after each successful sync.
/// The manifest of what has been unreferenced since when is `.gestalts/blob-gc.json`.
async fn collect_blobs(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Collected>, Response> {
    let s = state.store()?;
    if backend_access(&headers, &state).await?.is_some() { return Err(StatusCode::FORBIDDEN.into_response()); }
    let plugins = state.plugins.clone();
    let deleted = tokio::task::spawn_blocking(move || collect_folder(&s, plugins.gestalts()))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())?;
    Ok(Json(Collected { deleted: api(deleted)? }))
}

fn collect_folder(s: &FsStorage, gestalts: &gestalts_core::Gestalts) -> gestalts_core::storage::Result<Vec<String>> {
    let file = s.root().join(".gestalts").join("blob-gc.json");
    let mut manifest: gestalts_core::GcManifest = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    if !manifest.due(now) { return Ok(vec![]); }
    let mut ymls = Vec::new();
    for id in s.list_ymls_sync()? {
        if let Some(text) = s.read_yml_sync(&id)? { ymls.push((id, text)); }
    }
    let referenced = gestalts_core::referenced_blobs(ymls.iter().map(|(k, t)| (k.as_str(), t.as_str())), gestalts);
    let deleted = pollster::block_on(gestalts_core::collect_blobs(s, &referenced, &mut manifest, now))?;
    let json = serde_json::to_vec_pretty(&manifest).map_err(|e| StorageError::Io(e.to_string()))?;
    crate::paths::write_atomic(&file, &json).map_err(|e| StorageError::Io(e.to_string()))?;
    Ok(deleted)
}

async fn list_plugins(State(s): State<AppState>) -> Json<Vec<PluginView>> { Json(s.plugins.views().await) }

#[derive(Serialize)]
struct ServiceView { id: String, available: bool }

async fn list_services(State(s): State<AppState>) -> Json<Vec<ServiceView>> {
    Json(s.plugins.services().await.into_iter().map(|(id, available)| ServiceView { id, available }).collect())
}

/// How long a service may take to answer (a Typst compile, an OCR run, a local LLM's first reply while its model
/// loads) before the app gets a 504.
const SERVICE_TIMEOUT: Duration = Duration::from_secs(180);

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

// --- for views, through the app: HTTP to declared hosts, and completions (net.rs, llm.rs) ---

async fn net_request(State(s): State<AppState>, headers: HeaderMap, body: Bytes) -> Result<Response, Response> {
    app_only(&headers, &s).await?;
    Ok(s.net.handle(&headers, body).await)
}

#[derive(Deserialize)]
struct CompleteRequest {
    prompt: String,
    #[serde(default)]
    json: bool,
}

#[derive(Serialize)]
struct NoCompletion {
    error: String,
    tried: Vec<(crate::llm::ProviderId, String)>,
}

async fn llm_complete(State(s): State<AppState>, headers: HeaderMap, Json(req): Json<CompleteRequest>) -> Result<Response, Response> {
    app_only(&headers, &s).await?;
    Ok(match s.llm.complete(&req.prompt, req.json).await {
        Ok(c) => Json(c).into_response(),
        Err(tried) => {
            let error = if tried.iter().all(|(_, why)| why == "not set up") { "no LLM provider is set up".to_owned() } else { "no LLM provider answered".to_owned() };
            (StatusCode::SERVICE_UNAVAILABLE, Json(NoCompletion { error, tried })).into_response()
        }
    })
}

async fn llm_settings(State(s): State<AppState>, headers: HeaderMap) -> Result<Response, Response> {
    app_only(&headers, &s).await?;
    Ok(Json(s.llm.view()).into_response())
}

async fn llm_change(State(s): State<AppState>, headers: HeaderMap, Json(change): Json<SettingsChange>) -> Result<Response, Response> {
    app_only(&headers, &s).await?;
    s.llm.change(change).map(|v| Json(v).into_response()).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())
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

fn lan_of(s: &AppState) -> Result<Arc<Lan>, (StatusCode, String)> {
    s.lan.clone().ok_or((StatusCode::NOT_FOUND, "this node doesn't pair with devices".to_owned()))
}

/// Opens a pairing offer: the QR code a device scans.
async fn control_pairing(State(s): State<AppState>) -> Result<Json<Offer>, (StatusCode, String)> {
    let lan = lan_of(&s)?;
    lan.offer(&s).map(Json).map_err(|e| (StatusCode::CONFLICT, e))
}

async fn control_cancel_pairing(State(s): State<AppState>) -> Result<StatusCode, (StatusCode, String)> {
    let lan = lan_of(&s)?;
    lan.pairing.cancel();
    lan.update(&s).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn control_devices(State(s): State<AppState>) -> Result<Json<Vec<DeviceView>>, (StatusCode, String)> {
    Ok(Json(lan_of(&s)?.pairing.devices()))
}

/// Unpairs a device: its token stops working at once, and with no device left the node stops listening.
async fn control_forget_device(State(s): State<AppState>, UrlPath(id): UrlPath<String>) -> Result<StatusCode, (StatusCode, String)> {
    let lan = lan_of(&s)?;
    if !lan.pairing.forget(&id).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))? {
        return Err((StatusCode::NOT_FOUND, "no such device".into()));
    }
    lan.update(&s).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(StatusCode::NO_CONTENT)
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
        .route("/pairing", post(control_pairing).delete(control_cancel_pairing))
        .route("/devices", get(control_devices))
        .route("/devices/{id}", axum::routing::delete(control_forget_device))
        .route_layer(middleware::from_fn_with_state(state.clone(), control_auth));
    Router::new()
        .route("/health", get(health))
        .route("/events", get(events))
        .route("/ymls/{id}", get(read_yml).put(write_yml).delete(delete_yml))
        .route("/sync/hashes", get(sync_hashes))
        .route("/sync/read", post(sync_read))
        .route("/sync/write", post(sync_write))
        .route("/blobs", get(list_blobs))
        .route("/blobs/collect", post(collect_blobs))
        .route("/blobs/{name}", get(read_blob).put(write_blob).delete(delete_blob))
        .route("/plugins", get(list_plugins))
        .route("/services", get(list_services))
        .route("/services/{service}/{*path}", any(proxy_service))
        .route("/net", post(net_request))
        .route("/llm/complete", post(llm_complete))
        .route("/llm/settings", get(llm_settings).put(llm_change))
        .nest("/control", control)
        .fallback(get(app_file))
        .layer(middleware::from_fn_with_state(state.clone(), track_origin))
        .layer(DefaultBodyLimit::max(512 * 1024 * 1024))
        .layer(cors)
        .layer(middleware::from_fn(local_host_only))
        .with_state(state)
}

// --- the home network: paired devices over TLS (lan.rs) ---

#[derive(Serialize)]
struct LanHealth {
    app: &'static str,
    version: &'static str,
    api: u32,
    node_id: String,
    folder: Option<FolderInfo>,
}

async fn lan_health(State(s): State<AppState>) -> Json<LanHealth> {
    let node_id = s.lan.as_ref().map(|l| l.node_id().to_owned()).unwrap_or_default();
    Json(LanHealth { app: s.identity.name, version: env!("CARGO_PKG_VERSION"), api: API_VERSION, node_id, folder: s.folder().map(|f| f.info.clone()) })
}

#[derive(Deserialize)]
struct PairRequest { secret: String, name: String }

/// A device redeems the secret of the open offer for its token.
async fn pair(State(s): State<AppState>, Json(req): Json<PairRequest>) -> Response {
    let Some(lan) = s.lan.clone() else { return StatusCode::NOT_FOUND.into_response() };
    match lan.pairing.redeem(lan.node_id(), &req.secret, &req.name, &now_iso()) {
        Ok(paired) => Json(paired).into_response(),
        Err(Refused::Invalid) => (StatusCode::FORBIDDEN, "this pairing code expired or was used already").into_response(),
        Err(Refused::TooManyAttempts) => (StatusCode::TOO_MANY_REQUESTS, "too many attempts: wait a minute").into_response(),
    }
}

/// Lets through only paired devices (`Authorization: Bearer <device token>`). Removes the header afterwards, so the
/// handlers treat the device as an app, not as a worker.
async fn device_auth(State(s): State<AppState>, mut request: Request, next: Next) -> Response {
    let token = request.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer "));
    let known = match (token, &s.lan) {
        (Some(t), Some(lan)) => lan.pairing.check(t, &now_iso()).is_some(),
        _ => false,
    };
    if !known { return StatusCode::UNAUTHORIZED.into_response(); }
    request.headers_mut().remove(header::AUTHORIZATION);
    next.run(request).await
}

/// The API on the home network: the notes, blobs and sync for paired devices, and pairing. Not `/control`,
/// `/events`, the plugins or the app's frontend. No CORS: its clients are apps, not web pages.
pub fn lan_app(state: AppState) -> Router {
    let devices = Router::new()
        .route("/ymls/{id}", get(read_yml).put(write_yml).delete(delete_yml))
        .route("/sync/hashes", get(sync_hashes))
        .route("/sync/read", post(sync_read))
        .route("/sync/write", post(sync_write))
        .route("/blobs", get(list_blobs))
        .route("/blobs/collect", post(collect_blobs))
        .route("/blobs/{name}", get(read_blob).put(write_blob).delete(delete_blob))
        .route_layer(middleware::from_fn_with_state(state.clone(), device_auth));
    Router::new()
        .route("/health", get(lan_health))
        .route("/pair", post(pair))
        .merge(devices)
        .layer(DefaultBodyLimit::max(512 * 1024 * 1024))
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

    #[test]
    fn a_folder_of_old_files_is_refused_and_left_alone() {
        let dir = temp_dir("old");
        std::fs::create_dir_all(dir.join("notes")).unwrap();
        std::fs::write(dir.join("notes/a.yml"), "tags: [flashcard]\n").unwrap();
        assert!(Folder::open(&dir).err().unwrap().contains("before this format"));
        assert!(!dir.join(".gestalts").exists(), "nothing written");
        assert_eq!(std::fs::read_to_string(dir.join("notes/a.yml")).unwrap(), "tags: [flashcard]\n");
    }

    #[test]
    fn a_new_folder_is_marked_and_keeps_opening() {
        let dir = temp_dir("marked");
        Folder::open(&dir).unwrap();
        std::fs::write(dir.join("notes/a.yml"), "id: a\ngestalt: note@1\n").unwrap();
        Folder::open(&dir).unwrap();
        std::fs::write(dir.join(".gestalts/format"), "99").unwrap();
        assert!(Folder::open(&dir).is_err());
    }

    #[tokio::test]
    async fn no_folder_means_conflict_not_empty() {
        let app = app(state(None));
        assert_eq!(send(&app, get_req("/sync/hashes")).await.0, StatusCode::CONFLICT);
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
        let put = axum::http::Request::put("/ymls/through-api").body(Body::from("id: through-api\n")).unwrap();
        assert_eq!(send(&app, put).await.0, StatusCode::NO_CONTENT);
        let next = |rx: &mut tokio::sync::broadcast::Receiver<Event>| {
            let mut rx = rx.resubscribe();
            async move { tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("an event in time").unwrap() }
        };
        let got = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.expect("an event in time").unwrap();
        assert_eq!(got, Event::Changed { ymls: vec!["through-api".into()], blobs: vec![] });
        let waiting = next(&mut rx);
        std::fs::write(dir.join("notes/by-hand.yml"), "id: by-hand\n").unwrap();
        std::fs::write(dir.join("blobs/pic.png"), [1]).unwrap();
        std::fs::write(dir.join("notes/.ignored.yml.tmp"), "x").unwrap();
        assert_eq!(waiting.await, Event::Changed { ymls: vec!["by-hand".into()], blobs: vec!["pic.png".into()] });

        let other = temp_dir("events-other");
        let waiting = next(&mut rx);
        open_folder(&s, &other).unwrap();
        assert!(matches!(waiting.await, Event::Folder(Some(_))));
        let waiting = next(&mut rx);
        std::fs::write(other.join("notes/in-other.yml"), "id: in-other\n").unwrap();
        assert_eq!(waiting.await, Event::Changed { ymls: vec!["in-other".into()], blobs: vec![] });
    }

    #[tokio::test]
    async fn choosing_a_folder_serves_it_and_remembers_it() {
        let s = state(None);
        let paths = s.remember_in.clone().unwrap();
        let app = app(s);
        let dir = temp_dir("chosen");
        Folder::open(&dir).unwrap();
        std::fs::write(dir.join("notes/a.yml"), "title: A\n").unwrap();
        let choose = axum::http::Request::post("/control/folder").header(CONTROL_HEADER, "secret")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::json!({ "path": dir }).to_string())).unwrap();
        assert_eq!(send(&app, choose).await.0, StatusCode::OK);
        let (status, body) = send(&app, get_req("/sync/hashes")).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"a\""), "{body}");
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
        std::fs::write(dir.join("notes/a.yml"), "id: a\ngestalt: note@1\nblobs: [{file: used.png, label: pic}]\n").unwrap();
        std::fs::write(dir.join("blobs/used.png"), [1]).unwrap();
        std::fs::write(dir.join("blobs/unused.png"), [2]).unwrap();
        let del = axum::http::Request::delete("/ymls/a").body(Body::empty()).unwrap();
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

    #[tokio::test]
    async fn sync_endpoints() {
        let dir = temp_dir("sync");
        let app = app(state(Some(Folder::open(&dir).unwrap())));
        std::fs::write(dir.join("notes/a.yml"), "x: 1\n").unwrap();
        let (status, body) = send(&app, get_req("/sync/hashes")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, format!("{{\"a\":\"{}\"}}", gestalts_core::content_hash(b"x: 1\n")));
        let post = |uri: &str, json: serde_json::Value| axum::http::Request::post(uri).header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json.to_string())).unwrap();
        let write = post("/sync/write", serde_json::json!([{ "id": "b", "text": "y: 2\n" }, { "id": "c", "text": "z: 3\n" }]));
        assert_eq!(send(&app, write).await.0, StatusCode::NO_CONTENT);
        let (status, body) = send(&app, post("/sync/read", serde_json::json!({ "ids": ["b", "missing", "a"] }))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, r#"[{"id":"b","text":"y: 2\n"},{"id":"a","text":"x: 1\n"}]"#);
        let bad = post("/sync/write", serde_json::json!([{ "id": "../escape", "text": "" }]));
        assert_eq!(send(&app, bad).await.0, StatusCode::BAD_REQUEST);
    }

    /// Pairing a device over the home network, and syncing with it: TLS pinned to the node's key, a one-time secret,
    /// a token per device.
    #[tokio::test]
    async fn a_device_pairs_and_syncs_over_the_network() {
        use gestalts_core::{Gestalts, Memory, Storage};
        use gestalts_peer::paired::{PairingUri, connect, pair};

        let dir = temp_dir("lan");
        let s = state(Some(Folder::open(&dir).unwrap()));
        let lan = Arc::new(Lan::new(s.remember_in.as_ref().unwrap(), 0).unwrap());
        let s = s.with_lan(lan.clone());
        let app = app(s.clone());
        assert!(!lan.view().listening, "nothing paired: not on the network");

        let control = |method: &str, uri: &str| axum::http::Request::builder().method(method).uri(uri).header(CONTROL_HEADER, "secret").body(Body::empty()).unwrap();
        let (status, body) = send(&app, control("POST", "/control/pairing")).await;
        if status == StatusCode::CONFLICT && body.contains("isn't connected") {
            eprintln!("skipped: no network here");
            return;
        }
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(lan.view().listening);
        let offer: Offer = serde_json::from_str(&body).unwrap();
        let mut uri = PairingUri::parse(&offer.uri).unwrap();
        assert_eq!(uri.node_id, lan.node_id());
        // over loopback, which the listener (on every interface) answers too
        let port = lan.view().port;
        uri.addrs = vec![format!("127.0.0.1:{port}")];

        let impostor = PairingUri { node_id: "0".repeat(64), ..uri.clone() };
        assert!(pair(&impostor, "Phone").await.is_err(), "another certificate");
        let mut node = pair(&uri, "Phone").await.unwrap();
        assert!(pair(&uri, "Phone").await.is_err(), "the secret is used up");
        assert_eq!(lan.pairing.devices()[0].name, "Phone");

        let peer = connect(&mut node).await.unwrap();
        let local = Memory::default();
        local.write_yml("from-phone", "id: from-phone\n").await.unwrap();
        std::fs::write(dir.join("notes/on-disk.yml"), "id: on-disk\n").unwrap();
        let report = gestalts_core::sync(&local, &peer, &Memory::default(), &Gestalts::builtin(), "2026-01-01T00:00:00Z").await.unwrap();
        assert_eq!((report.pulled, report.pushed), (vec!["on-disk".to_owned()], vec!["from-phone".to_owned()]));
        assert!(dir.join("notes/from-phone.yml").exists());

        // without the token, or for anything but the notes: refused
        let client = gestalts_peer::paired::pinned_client(lan.node_id()).unwrap();
        let get = |path: &str| client.get(format!("https://127.0.0.1:{port}{path}")).send();
        assert_eq!(get("/sync/hashes").await.unwrap().status(), 401);
        assert_eq!(get("/control/status").await.unwrap().status(), 404);
        assert_eq!(get("/health").await.unwrap().status(), 200);

        // forgotten: its token stops working, and with nothing paired the node leaves the network
        let id = node.device_id.clone();
        assert_eq!(send(&app, control("DELETE", &format!("/control/devices/{id}"))).await.0, StatusCode::NO_CONTENT);
        assert!(peer.list_blobs().await.is_err());
        assert!(!lan.view().listening);
    }

    /// A phone's side of it (`gestalts_device`): pairing from the QR code's text, then syncing its own folder.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_device_folder_pairs_and_syncs() {
        use gestalts_peer::paired::PairingUri;

        struct Quiet;
        impl gestalts_device::Host for Quiet {
            fn event(&self, _: gestalts_device::Event) {}
        }

        let dir = temp_dir("device-node");
        let s = state(Some(Folder::open(&dir).unwrap()));
        let lan = Arc::new(Lan::new(s.remember_in.as_ref().unwrap(), 0).unwrap());
        let s = s.with_lan(lan.clone());
        let app = app(s.clone());
        let control = axum::http::Request::post("/control/pairing").header(CONTROL_HEADER, "secret").body(Body::empty()).unwrap();
        let (status, body) = send(&app, control).await;
        if status == StatusCode::CONFLICT && body.contains("isn't connected") {
            eprintln!("skipped: no network here");
            return;
        }
        let offer: Offer = serde_json::from_str(&body).unwrap();
        let mut uri = PairingUri::parse(&offer.uri).unwrap();
        uri.addrs = vec![format!("127.0.0.1:{}", lan.view().port)];
        std::fs::write(dir.join("notes/on-disk.yml"), "id: on-disk\n").unwrap();

        let phone = temp_dir("device-phone");
        let device = gestalts_device::spawn(phone.clone(), Quiet).unwrap();
        device.set_active(false).await.unwrap();
        let paired = device.pair(uri.to_string(), "Phone".into()).await.unwrap();
        assert_eq!(paired.node_id, lan.node_id());
        assert!(std::fs::read_to_string(phone.join("paired.json")).unwrap().contains(&lan.pairing.devices()[0].id));
        device.write_yml("from-phone".into(), "id: from-phone\n".into()).await.unwrap();
        // pairing syncs at once too: whichever sync ran first, both folders end up with both notes
        device.run(|d| Box::pin(async move { d.sync().await.map_err(|e| e.to_string()) })).await.unwrap().unwrap();
        assert!(dir.join("notes/from-phone.yml").exists());
        assert!(phone.join("data/notes/on-disk.yml").exists());
        let status = device.status().await.unwrap();
        assert_eq!(status.state, gestalts_device::SyncState::Ok);
        assert!(status.last_sync.is_some() && status.folder.is_some());
    }

    /// Needs multicast on a network interface, which CI and containers often lack: `cargo test -- --ignored mdns`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn mdns_finds_a_listening_node() {
        let s = state(None);
        let lan = Arc::new(Lan::new(s.remember_in.as_ref().unwrap(), 0).unwrap());
        let s = s.with_lan(lan.clone());
        lan.offer(&s).unwrap();
        let found = gestalts_peer::paired::discover(lan.node_id(), Duration::from_secs(5)).await;
        assert!(found.iter().any(|a| a.ends_with(&format!(":{}", lan.view().port))), "{found:?}");
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
        std::fs::write(dir.join("notes/on-disk.yml"), "id: on-disk\ngestalt: note@1\nblobs: [{file: disk.png, label: pic}]\n").unwrap();
        std::fs::write(dir.join("blobs/disk.png"), [1, 2]).unwrap();

        let peer = Peer::new(&url);
        let health = peer.health().await.unwrap();
        assert_eq!(health["folder"]["path"].as_str().map(Path::new), Some(dir.canonicalize().unwrap().as_path()));

        let local = Memory::default();
        local.write_yml("on-phone", "id: on-phone\nblobs: [phone.png]\n").await.unwrap();
        local.write_blob("phone.png", &[3]).await.unwrap();
        let base = Memory::default();
        let report = gestalts_core::sync_with(&local, &peer, &base, &Gestalts::builtin(), "2026-01-01T00:00:00Z", &mut |_| {}).await.unwrap();
        assert_eq!(report.pulled, ["on-disk"]);
        assert_eq!(report.pushed, ["on-phone"]);
        assert_eq!((report.blobs_pulled, report.blobs_pushed), (vec!["disk.png".to_owned()], vec!["phone.png".to_owned()]));
        assert!(std::fs::read_to_string(dir.join("notes/on-phone.yml")).unwrap().contains("phone.png"));
        assert_eq!(local.read_yml("on-disk").await.unwrap().unwrap(), "id: on-disk\ngestalt: note@1\nblobs: [{file: disk.png, label: pic}]\n");
        assert_eq!(std::fs::read(dir.join("blobs/phone.png")).unwrap(), [3]);
        assert_eq!(local.read_blob("disk.png").await.unwrap().unwrap(), [1, 2]);

        // nothing changed: only the hashes are compared
        let report = gestalts_core::sync(&local, &peer, &base, &Gestalts::builtin(), "2026-01-01T00:00:00Z").await.unwrap();
        assert_eq!((report.compared, report.pulled.len(), report.pushed.len()), (0, 0, 0));
        std::fs::write(dir.join("notes/on-disk.yml"), "id: on-disk
blobs: [disk.png]
edited: true
").unwrap();
        let report = gestalts_core::sync(&local, &peer, &base, &Gestalts::builtin(), "2026-01-01T00:00:00Z").await.unwrap();
        assert_eq!((report.compared, report.pulled), (1, vec!["on-disk".to_owned()]));

        assert_eq!(peer.read_yml("missing").await.unwrap(), None);
        peer.delete_yml("on-phone").await.unwrap();
        assert!(gestalts_core::is_tombstone_text(&peer.read_yml("on-phone").await.unwrap().unwrap()));
    }
}
