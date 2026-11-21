//! The lesson domain: another registrable domain than the app's, so nothing published shares cookies or storage with
//! a teacher's session.
//!
//! - `/l/<lesson>`: the player its current version was made for, from `runtime/<version>/` (with a `<base>` there)
//! - `/l/<lesson>/current`: `{manifest}`, the one answer that changes; 410 once switched off
//! - `/lessons/…`, `/npm/…`, `/runtime/…`: static and immutable, named by what's in them
//!
//! Nothing here is indexed or tells where a student came from, and guessing at links is slowed down.

use std::path::{Component, Path as FsPath};
use std::sync::Mutex;
use std::time::Instant;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;

use crate::AppState;

/// Not-founds per minute, over all of them, before the lesson domain answers 429 to more.
const MISSES_PER_MINUTE: u32 = 120;

#[derive(Default)]
pub struct Misses(Mutex<(u32, Option<Instant>)>);

impl Misses {
    /// Counts one; whether there were too many this minute.
    fn too_many(&self) -> bool {
        let mut m = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if m.1.is_none_or(|t| t.elapsed().as_secs() >= 60) {
            *m = (0, Some(Instant::now()));
        }
        m.0 += 1;
        m.0 > MISSES_PER_MINUTE
    }
}

/// The player page's policy. Its frame inherits it (a srcdoc frame does), and adds its own closed one on top.
const PLAYER_CSP: &str = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; \
    style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob: data:; font-src 'self' blob: data:; \
    connect-src 'self'; worker-src 'self' blob:; frame-src 'self' blob: data: about:; object-src 'none'; base-uri 'self'; \
    form-action 'none'; frame-ancestors 'none'";

fn private(h: &mut HeaderMap) {
    h.insert("x-robots-tag", HeaderValue::from_static("noindex, nofollow"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
}

fn gone(status: StatusCode) -> Response {
    let mut res = (status, Html("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>Lesson</title><p style='font:1.1rem system-ui;margin:3rem auto;max-width:28rem;text-align:center'>This lesson isn’t available. The link was switched off or has expired: ask your teacher for a new one.")).into_response();
    private(res.headers_mut());
    res
}

fn valid_lesson(id: &str) -> bool {
    id.len() == 22 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The publication's current manifest path, if it's on.
fn current(state: &AppState, id: &str) -> Result<String, StatusCode> {
    if !valid_lesson(id) {
        return Err(StatusCode::NOT_FOUND);
    }
    match state.db.publication(id) {
        Ok(Some(p)) if p.revoked.is_none() => Ok(p.manifest),
        Ok(Some(_)) => Err(StatusCode::GONE),
        Ok(None) => Err(StatusCode::NOT_FOUND),
        Err(_) => Err(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

fn miss(state: &AppState, status: StatusCode) -> Response {
    if status == StatusCode::NOT_FOUND && state.misses.too_many() {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    gone(status)
}

async fn lesson(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let manifest = match current(&state, &id) {
        Ok(m) => m,
        Err(s) => return miss(&state, s),
    };
    let runtime = std::fs::read(state.data.join(manifest.trim_start_matches('/')))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|m| m["runtime"].as_str().map(str::to_owned))
        .filter(|r| r.len() == 16 && r.bytes().all(|b| b.is_ascii_hexdigit()));
    let Some(runtime) = runtime else { return gone(StatusCode::INTERNAL_SERVER_ERROR) };
    let Ok(html) = std::fs::read_to_string(state.data.join("runtime").join(&runtime).join("index.html")) else { return gone(StatusCode::SERVICE_UNAVAILABLE) };
    let html = html.replacen("<head>", &format!("<head><base href=\"/runtime/{runtime}/\">"), 1);
    let mut res = Html(html).into_response();
    let h = res.headers_mut();
    private(h);
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(PLAYER_CSP));
    res
}

async fn lesson_current(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    match current(&state, &id) {
        Ok(manifest) => {
            let mut res = Json(json!({ "manifest": manifest })).into_response();
            private(res.headers_mut());
            res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
            res
        }
        Err(s) => {
            if s == StatusCode::NOT_FOUND && state.misses.too_many() {
                return StatusCode::TOO_MANY_REQUESTS.into_response();
            }
            let mut res = (s, Json(json!({ "error": "not available" }))).into_response();
            private(res.headers_mut());
            res
        }
    }
}

/// A file under `root` of the data folder, by a path with nothing that leaves it.
async fn file(state: &AppState, root: &str, rest: &str) -> Response {
    let rel = FsPath::new(rest);
    if rest.is_empty() || rel.components().any(|c| !matches!(c, Component::Normal(_))) || rest.split('/').any(|p| p.starts_with('.')) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = state.data.join(root).join(rel);
    let Ok(bytes) = tokio::fs::read(&path).await else {
        if state.misses.too_many() { return StatusCode::TOO_MANY_REQUESTS.into_response(); }
        return StatusCode::NOT_FOUND.into_response();
    };
    let mime = match path.extension().and_then(|e| e.to_str()).unwrap_or_default() {
        "js" | "mjs" => "text/javascript; charset=utf-8".to_owned(),
        "json" => "application/json".to_owned(),
        "css" => "text/css; charset=utf-8".to_owned(),
        "html" => "text/html; charset=utf-8".to_owned(),
        "wasm" => "application/wasm".to_owned(),
        "svg" => "image/svg+xml".to_owned(),
        _ => mime_guess::from_path(&path).first_or_octet_stream().to_string(),
    };
    let mut res = bytes.into_response();
    let h = res.headers_mut();
    private(h);
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(&mime).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    // named by their content, so never refetched; and imported by sandboxed frames, whose origin is `null`
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    res
}

async fn lessons_file(State(state): State<AppState>, Path(rest): Path<String>) -> Response {
    file(&state, "lessons", &rest).await
}

async fn npm_file(State(state): State<AppState>, Path(rest): Path<String>) -> Response {
    file(&state, "npm", &rest).await
}

async fn runtime_file(State(state): State<AppState>, Path(rest): Path<String>) -> Response {
    // the page itself only through /l/<lesson>, which gives it its <base>
    if rest.ends_with("index.html") {
        return StatusCode::NOT_FOUND.into_response();
    }
    file(&state, "runtime", &rest).await
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/l/{id}", get(lesson))
        .route("/l/{id}/", get(lesson))
        .route("/l/{id}/current", get(lesson_current))
        .route("/lessons/{*rest}", get(lessons_file))
        .route("/npm/{*rest}", get(npm_file))
        .route("/runtime/{*rest}", get(runtime_file))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lesson_ids() {
        assert!(valid_lesson("AbCdEfGhIjKlMnOpQrStUv"));
        assert!(!valid_lesson("short") && !valid_lesson("AbCdEfGhIjKlMnOpQrSt/v"));
    }
}
