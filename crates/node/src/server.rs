//! The HTTP API on 127.0.0.1: notes and blobs of the open folder for the web apps, scoped access
//! for plugin workers, and `/control/*` for the connector's own status window.

// handlers return `Result<_, Response>`, axum's idiom; the large error only ever goes straight out as a reply
#![allow(clippy::result_large_err)]

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path as UrlPath, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{any, get, post};
use gestalts_core::StorageError;
use gestalts_fs::FsStorage;
use serde::{Deserialize, Serialize};
use tower_http::cors::{AllowOrigin, CorsLayer};

use crate::paths::{Config, Paths};
use crate::plugins::{PluginHost, PluginView};
use crate::uv::UvState;

/// Where the deployed web frontends live; they may always connect.
/// Header carrying the per-run control token (see `paths::Paths::control_token_file`).
pub const CONTROL_HEADER: &str = "x-gestalts-control";
/// A frontend counts as connected if it made a request this recently (they sync every 15 s).
const CONNECTED_FOR: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// What the server asks of the desktop UI, if there is one.
#[derive(Debug, Clone)]
pub enum UiRequest {
    ShowStatus,
    FolderChanged(Option<FolderInfo>),
    Quit,
}

#[derive(Clone)]
pub struct AppState {
    folder: Arc<RwLock<Option<Arc<Folder>>>>,
    plugins: PluginHost,
    clients: Arc<Mutex<BTreeMap<String, Instant>>>,
    control_token: Arc<str>,
    /// where to remember a newly chosen folder; None when the folder came from the command line
    remember_in: Option<Paths>,
    ui: Arc<dyn Fn(UiRequest) + Send + Sync>,
    address: String,
    /// web origins allowed besides localhost and the app's own frontends
    extra_origins: Arc<[String]>,
}

impl AppState {
    pub fn new(folder: Option<Folder>, plugins: PluginHost, control_token: String, remember_in: Option<Paths>,
               ui: Arc<dyn Fn(UiRequest) + Send + Sync>, address: String, extra_origins: Vec<String>) -> Self {
        AppState { folder: Arc::new(RwLock::new(folder.map(Arc::new))), plugins, clients: Arc::default(),
                   control_token: control_token.into(), remember_in, ui, address, extra_origins: extra_origins.into() }
    }

    fn folder(&self) -> Option<Arc<Folder>> { self.folder.read().expect("folder lock").clone() }

    fn store(&self) -> Result<Arc<FsStorage>, Response> {
        self.folder().map(|f| f.store.clone())
            .ok_or_else(|| (StatusCode::CONFLICT, "no folder open; choose one in the Gestalts Connector").into_response())
    }

    fn status(&self, plugins: Vec<PluginView>) -> StatusView {
        let now = Instant::now();
        let clients = self.clients.lock().expect("clients lock").iter()
            .filter(|(_, seen)| now.duration_since(**seen) < CONNECTED_FOR)
            .map(|(origin, seen)| ClientView { origin: origin.clone(), seconds_ago: now.duration_since(*seen).as_secs() })
            .collect();
        StatusView { version: env!("CARGO_PKG_VERSION").into(), address: self.address.clone(), folder: self.folder().map(|f| f.info.clone()),
                     clients, plugins, uv: self.plugins.uv_state() }
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

/// Everything the status window shows.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusView {
    pub version: String,
    pub address: String,
    pub folder: Option<FolderInfo>,
    pub clients: Vec<ClientView>,
    pub plugins: Vec<PluginView>,
    pub uv: UvState,
}

#[derive(Serialize)]
struct NoteEntry {
    key: String,
    text: String,
}

async fn health(State(s): State<AppState>) -> Json<Health> {
    Json(Health { app: "gestalts-connector", version: env!("CARGO_PKG_VERSION"), folder: s.folder().map(|f| f.info.clone()) })
}

async fn worker_access(headers: &HeaderMap, state: &AppState) -> Result<Option<gestalts_plugin_host::Access>, Response> {
    let Some(value) = headers.get(header::AUTHORIZATION) else { return Ok(None) };
    let value = value.to_str().map_err(|_| StatusCode::UNAUTHORIZED.into_response())?;
    let token = value.strip_prefix("Bearer ").ok_or_else(|| StatusCode::UNAUTHORIZED.into_response())?;
    state.plugins.policy_for_token(token).await.map(Some).ok_or_else(|| StatusCode::UNAUTHORIZED.into_response())
}

fn readable(gestalts: &gestalts_core::Gestalts, access: &gestalts_plugin_host::Access, key: &str, text: &str) -> bool {
    let note = gestalts_core::Note::parse(key, text);
    let gs = gestalts.of(&note);
    access.read.gestalts.iter().any(|g| gs.contains(g)) && access.read.tags_all.iter().all(|t| note.has_tag(t))
}

fn writable(access: &gestalts_plugin_host::Access, key: &str, text: &str) -> bool {
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
fn referenced_blobs(s: &FsStorage, gestalts: &gestalts_core::Gestalts, access: &gestalts_plugin_host::Access) -> Result<std::collections::BTreeSet<String>, Response> {
    let mut names = std::collections::BTreeSet::new();
    if access.blobs.read != gestalts_plugin_host::BlobRead::Referenced { return Ok(names); }
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

// --- control: only the connector's own UI, never a web page ---

async fn control_auth(State(state): State<AppState>, request: Request, next: Next) -> Response {
    // browsers always send Origin on cross-origin requests; the status window never does
    if request.headers().contains_key(header::ORIGIN) { return StatusCode::FORBIDDEN.into_response(); }
    let token = request.headers().get(CONTROL_HEADER).and_then(|v| v.to_str().ok());
    if token != Some(&*state.control_token) { return StatusCode::UNAUTHORIZED.into_response(); }
    next.run(request).await
}

async fn control_status(State(s): State<AppState>) -> Json<StatusView> {
    let plugins = s.plugins.views().await;
    Json(s.status(plugins))
}

#[derive(Deserialize)]
pub struct ChooseFolder { pub path: String }

async fn control_folder(State(s): State<AppState>, Json(req): Json<ChooseFolder>) -> Result<Json<StatusView>, (StatusCode, String)> {
    let folder = Folder::open(Path::new(&req.path)).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let info = folder.info.clone();
    if let Some(paths) = &s.remember_in {
        let mut config = Config::load(paths);
        config.folder = Some(info.path.clone().into());
        config.save(paths).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("cannot save the config: {e}")))?;
    }
    *s.folder.write().expect("folder lock") = Some(Arc::new(folder));
    (s.ui)(UiRequest::FolderChanged(Some(info)));
    Ok(control_status(State(s)).await)
}

async fn control_show(State(s): State<AppState>) -> StatusCode {
    (s.ui)(UiRequest::ShowStatus);
    StatusCode::NO_CONTENT
}

async fn control_quit(State(s): State<AppState>) -> StatusCode {
    (s.ui)(UiRequest::Quit);
    StatusCode::NO_CONTENT
}

/// Remembers which (allowed) web frontends talk to us, for the status window.
async fn track_origin(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if let Some(origin) = request.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok())
        && origin_allowed(origin, &state.extra_origins) {
        state.clients.lock().expect("clients lock").insert(origin.to_owned(), Instant::now());
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
        .route("/show", post(control_show))
        .route("/quit", post(control_quit))
        .route_layer(middleware::from_fn_with_state(state.clone(), control_auth));
    Router::new()
        .route("/health", get(health))
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
        .layer(middleware::from_fn_with_state(state.clone(), track_origin))
        .layer(DefaultBodyLimit::max(512 * 1024 * 1024))
        .layer(cors)
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

    fn state(folder: Option<Folder>) -> AppState {
        let root = temp_dir("paths");
        let paths = Paths { config: root.join("config"), data: root.join("data"), cache: root.join("cache") };
        let plugins = PluginHost::discover(&[], "http://127.0.0.1:0".into(), paths.clone()).unwrap();
        AppState::new(folder, plugins, "secret".into(), Some(paths), Arc::new(|_| {}), "http://127.0.0.1:0".into(), vec![APP_ORIGIN.into()])
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
}
