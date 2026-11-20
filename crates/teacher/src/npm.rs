//! npm packages for a draft's preview, bundled here (`@gestalts/npm-bundle` in the worker) and served from the app's
//! origin, so a teacher's preview loads what a student's player will: the same bundles, pinned.
//!
//! Bundling only happens for a signed-in teacher (`POST /api/npm`). The bundles themselves are served to anyone
//! (`GET /api/npm/<file>`): a sandboxed frame's module requests carry no cookies and come from origin `null`.

use std::collections::BTreeMap;

use axum::extract::{Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::auth::Teacher;
use crate::{ApiError, ApiResult, AppState};

/// The package of an import: `three` of `three/addons/x.js`, `@scope/pkg` of `@scope/pkg/x`.
pub fn package_of(spec: &str) -> &str {
    let n = if spec.starts_with('@') { 2 } else { 1 };
    match spec.match_indices('/').nth(n - 1) {
        Some((i, _)) => &spec[..i],
        None => spec,
    }
}

#[derive(Deserialize)]
pub struct Ensure {
    /// package name to exact version, as a draft's view.json has it
    pub npm: BTreeMap<String, String>,
    /// what the view imports from npm
    pub imports: Vec<String>,
}

/// Bundles each import at its package's version: where each is served, a subpath's package root included.
pub async fn ensure(state: &AppState, req: &Ensure) -> Result<BTreeMap<String, BundledFile>, String> {
    let mut out = BTreeMap::new();
    let mut todo: Vec<String> = req.imports.clone();
    while let Some(spec) = todo.pop() {
        if out.contains_key(&spec) {
            continue;
        }
        let name = package_of(&spec);
        let version = req.npm.get(name).ok_or_else(|| format!("{spec}: no version of {name} in view.json's npm"))?;
        let b = state.worker.call("npm", json!({ "specifier": spec, "version": version })).await?;
        let file = std::path::Path::new(b["file"].as_str().unwrap_or_default()).to_owned();
        let hash = b["hash"].as_str().unwrap_or_default().to_owned();
        for need in b["needs"].as_array().into_iter().flatten().filter_map(|n| n.as_str()) {
            todo.push(need.to_owned());
        }
        out.insert(spec, BundledFile { file, hash });
    }
    Ok(out)
}

pub struct BundledFile {
    /// in the worker's cache
    pub file: std::path::PathBuf,
    pub hash: String,
}

async fn post_ensure(State(state): State<AppState>, _teacher: Teacher, Json(req): Json<Ensure>) -> ApiResult<Json<BTreeMap<String, String>>> {
    let bundled = ensure(&state, &req).await.map_err(ApiError::BadRequest)?;
    Ok(Json(bundled.into_iter().map(|(spec, b)| (spec, format!("/api/npm/{}", b.file.file_name().and_then(|f| f.to_str()).unwrap_or_default()))).collect()))
}

/// A bundle as JavaScript any frame may import: immutable, since its name says package and version.
pub fn serve_js(bytes: Vec<u8>) -> Response {
    let mut res = bytes.into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/javascript; charset=utf-8"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    res
}

/// A bundle's file name: `<specifier, with / as +>@<version>.js`, nothing that leaves the folder.
pub fn valid_file(name: &str) -> bool {
    !name.contains("..") && name.ends_with(".js") && name.len() <= 300 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._@+-".contains(&b))
}

async fn get_bundle(State(state): State<AppState>, Path(file): Path<String>) -> Response {
    if !valid_file(&file) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = state.worker.config().npm_cache.join("bundles").join(&file);
    match tokio::fs::read(path).await {
        Ok(b) => serve_js(b),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/npm", post(post_ensure)).route("/npm/{file}", get(get_bundle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packages_of_imports() {
        assert_eq!(package_of("three"), "three");
        assert_eq!(package_of("three/addons/x.js"), "three");
        assert_eq!(package_of("@scope/pkg"), "@scope/pkg");
        assert_eq!(package_of("@scope/pkg/x"), "@scope/pkg");
        assert!(valid_file("three@0.170.0.js") && valid_file("three+addons+x.js@0.170.0.js"));
        assert!(!valid_file("../x.js") && !valid_file("a/b.js") && !valid_file("x.json"));
    }
}
