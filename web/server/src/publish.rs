//! Publishing a draft as a lesson: data, not a build. Each version is a folder of static files on the lesson domain
//! (`packages/workshop/src/lesson.ts` has the format), named by what's in it, and a publication points at its current
//! one. A draft has one publication, so its link stays the same across versions; unpublishing switches the link off.
//!
//! Before anything is written:
//! - the view compiles, and each npm import is pinned in view.json and bundles
//! - it reads and writes only gestalts the player has or the draft defines, and every member is valid
//! - the player for the runtime the draft was made against is deployed here
//! - a gestalt published before keeps its structure (a change is a new version); a lesson whose gestalts changed since
//!   its last version is published with a warning, since students' data stays on their devices

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use gestalts_core::gestalt::GESTALT;
use gestalts_core::{Yml, YmlState, blobs_of};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::auth::Teacher;
use crate::npm::{Ensure, ensure, package_of};
use crate::validate::{draft_gestalts, is_view};
use crate::{ApiError, ApiResult, AppState, now_iso, random_token};

#[derive(Serialize)]
pub struct Published {
    pub id: String,
    pub url: String,
    pub manifest: String,
    pub updated: String,
    pub revoked: Option<String>,
    /// what the teacher should know, though it went out
    pub warnings: Vec<String>,
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn strings(v: &serde_yaml_ng::Value) -> Vec<String> {
    v.as_sequence().into_iter().flatten().filter_map(|s| s.as_str().map(str::to_owned)).collect()
}

/// A bundle's file name on the lesson domain: by specifier, version and content, shared by every lesson.
fn npm_name(spec: &str, version: &str, hash: &str) -> String {
    let safe: String = spec.chars().map(|c| if c.is_ascii_alphanumeric() || "._@-".contains(c) { c } else { '+' }).collect();
    format!("{safe}@{version}-{}.js", &hash[..12])
}

fn io(e: std::io::Error) -> ApiError {
    ApiError::Internal(e.to_string())
}

/// What the lesson folder holds before it's written.
struct Version {
    files: BTreeMap<String, Vec<u8>>,
    /// blob name to where it is in the draft
    blobs: BTreeMap<String, PathBuf>,
    npm: BTreeMap<String, (PathBuf, String)>,
    definitions: BTreeMap<String, String>,
}

async fn build(state: &AppState, draft: &crate::db::Draft) -> ApiResult<Version> {
    let dir = state.draft_dir(&draft.id);
    let s = gestalts_fs::FsStorage::new(&dir);
    let view_text = s.read_yml_sync(&draft.id)?.ok_or_else(|| ApiError::BadRequest("the draft has no view yet".into()))?;
    let view = Yml::parse(draft.id.clone(), view_text);
    if !matches!(state.gestalts.classify(&view), YmlState::Valid(ref g) if is_view(g)) {
        return Err(ApiError::BadRequest("the draft's view isn't valid".into()));
    }
    let m = view.map().ok_or_else(|| ApiError::BadRequest("the draft's view isn't valid".into()))?;
    let field = |k: &str| m.get(k).cloned().unwrap_or(serde_yaml_ng::Value::Null);
    let (title, source) = (view.str_field("title").unwrap_or_default().to_owned(), view.str_field("source").unwrap_or_default().to_owned());
    let (reads, writes, members) = (strings(&field("reads")), strings(&field("writes")), strings(&field("members")));
    let runtime = view.str_field("runtime").ok_or_else(|| ApiError::BadRequest("the draft doesn't say which runtime it was made against: open it once in the app".into()))?.to_owned();
    let npm: BTreeMap<String, String> = field("npm").as_mapping().into_iter().flatten().filter_map(|(k, v)| Some((k.as_str()?.to_owned(), v.as_str()?.to_owned()))).collect();
    let mut problems = Vec::new();

    if !(runtime.len() == 16 && runtime.bytes().all(|b| b.is_ascii_hexdigit())) {
        return Err(ApiError::BadRequest(format!("{runtime} isn't a runtime")));
    }
    if !state.data.join("runtime").join(&runtime).join("index.html").is_file() {
        problems.push(format!("the player for runtime {runtime} isn't installed here: the app was updated, so reload it, open the draft and publish again"));
    }

    // the members, as the lesson ships them
    let mut texts = BTreeMap::new();
    for id in &members {
        match s.read_yml_sync(id)? {
            Some(t) => { texts.insert(id.clone(), t); }
            None => problems.push(format!("{id}: a member that isn't there")),
        }
    }
    let gestalts = draft_gestalts(&state.gestalts, &draft.package, texts.iter().filter(|(_, t)| t.contains(GESTALT)).map(|(i, t)| (i.clone(), t.clone())));
    let mut definitions = BTreeMap::new();
    let mut blobs = BTreeMap::new();
    for (id, text) in &texts {
        let y = Yml::parse(id.clone(), text.clone());
        let st = gestalts.classify(&y);
        match &st {
            YmlState::Valid(g) if g == GESTALT => {
                if let Ok(d) = gestalts.definition(&y) {
                    definitions.insert(d.id(), d.structure_hash());
                }
            }
            YmlState::Valid(_) => {}
            _ => problems.push(format!("{id}: not valid")),
        }
        for b in blobs_of(&y, &st, &gestalts).into_iter().filter(|b| gestalts_core::yml::valid_key(b)) {
            let p = dir.join("blobs").join(&b);
            if p.is_file() { blobs.insert(b, p); } else { problems.push(format!("{id}: its file {b} isn't there")); }
        }
    }
    for g in reads.iter().chain(&writes) {
        if gestalts.get(g).is_none() {
            problems.push(format!("view.json: no gestalt {g} in a lesson"));
        }
    }
    for g in &writes {
        if !reads.contains(g) { problems.push(format!("view.json: it writes {g} without reading it")); }
    }

    // the view, compiled as the frame loads it
    let compiled = state.worker.call("compile", json!({ "source": source })).await.map_err(ApiError::Internal)?;
    if compiled["ok"] != true {
        let errs: Vec<String> = compiled["errors"].as_array().into_iter().flatten().map(|e| e["message"].as_str().unwrap_or_default().to_owned()).collect();
        problems.push(format!("view.tsx doesn't compile: {}", errs.join("; ")));
    }
    let imports: Vec<String> = compiled["npm"].as_array().into_iter().flatten().filter_map(|s| s.as_str().map(str::to_owned)).collect();
    for spec in &imports {
        if !npm.get(package_of(spec)).is_some_and(|v| v.split('.').count() == 3) {
            problems.push(format!("view.json: npm: {} needs an exact version", package_of(spec)));
        }
    }
    if !problems.is_empty() {
        return Err(ApiError::Invalid(problems));
    }
    let bundled = ensure(state, &Ensure { npm: npm.clone(), imports }).await.map_err(|e| ApiError::Invalid(vec![e]))?;
    let mut npm_files = BTreeMap::new();
    for (spec, b) in bundled {
        let version = npm.get(package_of(&spec)).cloned().unwrap_or_default();
        npm_files.insert(spec.clone(), (b.file, npm_name(&spec, &version, &b.hash)));
    }

    let js = compiled["js"].as_str().unwrap_or_default().as_bytes().to_vec();
    let ymls: Vec<Value> = texts.iter().map(|(id, text)| json!({ "id": id, "text": text })).collect();
    let index = json!({ "ymls": texts.keys().collect::<Vec<_>>(), "blobs": blobs.keys().collect::<Vec<_>>() });
    let mut files = BTreeMap::new();
    let view_name = format!("view.{}.js", &hex(&js)[..12]);
    files.insert(view_name.clone(), js);
    files.insert("ymls.json".to_owned(), serde_json::to_vec(&ymls).expect("json"));
    files.insert("index.json".to_owned(), serde_json::to_vec(&index).expect("json"));
    let manifest = json!({
        "format": "lesson@1",
        "title": title,
        "runtime": runtime,
        "reads": reads,
        "writes": writes,
        "view": view_name,
        "npm": npm_files.iter().map(|(spec, (_, name))| (spec.clone(), json!(format!("/npm/{name}")))).collect::<serde_json::Map<_, _>>(),
        "published": now_iso(),
    });
    files.insert("manifest.json".to_owned(), serde_json::to_vec_pretty(&manifest).expect("json"));
    Ok(Version { files, blobs, npm: npm_files, definitions })
}

/// The version's name: a hash of everything in it but when it was published.
fn version_name(v: &Version) -> ApiResult<String> {
    let mut h = Sha256::new();
    for (name, bytes) in &v.files {
        h.update(name.as_bytes());
        if name == "manifest.json" {
            let mut m: Value = serde_json::from_slice(bytes).map_err(|e| ApiError::Internal(e.to_string()))?;
            m.as_object_mut().map(|o| o.remove("published"));
            h.update(m.to_string().as_bytes());
        } else {
            h.update(bytes);
        }
    }
    for (name, path) in &v.blobs {
        h.update(name.as_bytes());
        h.update(std::fs::read(path).map_err(io)?);
    }
    Ok(h.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect())
}

fn write(state: &AppState, lesson: &str, name: &str, v: &Version) -> ApiResult<()> {
    let dir = state.data.join("lessons").join(lesson).join(name);
    if dir.join("manifest.json").is_file() {
        // the same content again: already there, and it never changes
        return Ok(());
    }
    let tmp = state.data.join("lessons").join(lesson).join(format!(".{name}.tmp"));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(tmp.join("blobs")).map_err(io)?;
    for (file, bytes) in &v.files {
        std::fs::write(tmp.join(file), bytes).map_err(io)?;
    }
    for (b, from) in &v.blobs {
        std::fs::copy(from, tmp.join("blobs").join(b)).map_err(io)?;
    }
    let npm = state.data.join("npm");
    std::fs::create_dir_all(&npm).map_err(io)?;
    for (from, name) in v.npm.values() {
        if !npm.join(name).is_file() {
            std::fs::copy(from, npm.join(format!(".{name}.tmp"))).map_err(io)?;
            std::fs::rename(npm.join(format!(".{name}.tmp")), npm.join(name)).map_err(io)?;
        }
    }
    std::fs::rename(&tmp, &dir).map_err(io)
}

impl AppState {
    fn lesson_url(&self, id: &str) -> String {
        format!("{}/l/{id}", self.lesson_origin.trim_end_matches('/'))
    }

    fn published(&self, p: crate::db::Publication, warnings: Vec<String>) -> Published {
        Published { url: self.lesson_url(&p.id), id: p.id, manifest: p.manifest, updated: p.updated, revoked: p.revoked, warnings }
    }
}

async fn publish(State(state): State<AppState>, teacher: Teacher, Path(id): Path<String>) -> ApiResult<Json<Published>> {
    let (draft, _) = state.own_draft(&teacher, &id)?;
    let _guard = state.writes.lock().await;
    let version = build(&state, &draft).await?;
    let previous = state.db.publication_of(&draft.id)?;
    let mut warnings = Vec::new();
    if let Some(p) = &previous {
        let before: BTreeMap<String, String> = serde_json::from_str(&p.definitions).unwrap_or_default();
        let changed: Vec<String> = version.definitions.iter().filter(|(g, h)| before.get(*g).is_some_and(|b| b != *h)).map(|(g, _)| {
            let (name, n) = g.rsplit_once('@').unwrap_or((g, "1"));
            format!("{g} was published before with other fields: name the changed one {name}@{}", n.parse::<u32>().unwrap_or(1) + 1)
        }).collect();
        if !changed.is_empty() {
            return Err(ApiError::Invalid(changed));
        }
        let (old, new): (BTreeSet<&String>, BTreeSet<&String>) = (before.keys().collect(), version.definitions.keys().collect());
        if old != new {
            warnings.push("This version keeps its data in other gestalts than the last one: what students did with the last version stays on their devices, but this one doesn't show it.".into());
        }
    }
    let lesson = previous.as_ref().map_or_else(|| random_token(16), |p| p.id.clone());
    let name = version_name(&version)?;
    let definitions = serde_json::to_string(&version.definitions).expect("json");
    {
        let st = state.clone();
        let (l, n) = (lesson.clone(), name.clone());
        tokio::task::spawn_blocking(move || write(&st, &l, &n, &version)).await.map_err(|e| ApiError::Internal(e.to_string()))??;
    }
    let manifest = format!("/lessons/{lesson}/{name}/manifest.json");
    let now = now_iso();
    match previous {
        Some(_) => state.db.update_publication(&lesson, &manifest, &definitions, &now)?,
        None => state.db.add_publication(&lesson, &draft, &manifest, &definitions, &now)?,
    }
    let p = state.db.publication(&lesson)?.ok_or_else(|| ApiError::Internal("the publication just written isn't there".into()))?;
    Ok(Json(state.published(p, warnings)))
}

async fn get_publication(State(state): State<AppState>, teacher: Teacher, Path(id): Path<String>) -> ApiResult<Json<Option<Published>>> {
    let (draft, _) = state.own_draft(&teacher, &id)?;
    Ok(Json(state.db.publication_of(&draft.id)?.map(|p| state.published(p, vec![]))))
}

async fn unpublish(State(state): State<AppState>, teacher: Teacher, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let (draft, _) = state.own_draft(&teacher, &id)?;
    let p = state.db.publication_of(&draft.id)?.ok_or(ApiError::NotFound)?;
    state.db.revoke_publication(&p.id, &now_iso())?;
    Ok(StatusCode::NO_CONTENT)
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/drafts/{id}/publish", post(publish))
        .route("/drafts/{id}/publication", axum::routing::get(get_publication).delete(unpublish))
}
