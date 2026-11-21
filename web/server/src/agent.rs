//! The agent, run here on our API key: a tool loop over a draft's files, held in memory, never a filesystem or a shell.
//! It speaks the workshop's job protocol (`@gestalts/workshop`'s `httpBackend`) under `/api/drafts/<id>/agent/`:
//!
//! - `GET status` → `{available, reason?}`
//! - `POST turn` `{view, session?, message, files, gestalts, diagnostics}` → 202 `{job}`
//! - `GET events?job=&after=n` → `{events, next, done}`, waiting up to 20 s for events after the n-th
//! - `POST cancel` `{job}`
//!
//! Like the local CLI agent, it hands back the files it changed; the browser writes the ymls, which the sync
//! validates. Its tools read and write the draft's files, read the kit's sources and the examples (the agent
//! template's, read-only), search them, and run the check (the worker). One turn at a time per teacher, each within
//! their monthly token budget.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path as FsPath, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Notify;

use crate::auth::Teacher;
use crate::{ApiError, ApiResult, AppState, now_iso, random_hex};

pub const MODEL: &str = "claude-opus-5-5";
const API_VERSION: &str = "2026-10-21";
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
const MAX_TOKENS: u32 = 16_000;
/// Model calls in one turn, at most: a turn that needs more is a turn too big.
const MAX_STEPS: usize = 40;
const EVENT_POLL: Duration = Duration::from_secs(20);
const FINISHED_KEEP: Duration = Duration::from_secs(600);
const SESSION_KEEP: Duration = Duration::from_secs(24 * 3600);
const MAX_FILE_BYTES: usize = 512 * 1024;
const MAX_READ_BYTES: usize = 200 * 1024;

/// What a draft is, as files; anything else the agent writes is refused.
pub fn is_draft_file(path: &str) -> bool {
    if matches!(path, "view.tsx" | "view.json") {
        return true;
    }
    if let Some(rest) = path.strip_prefix("gestalts/") {
        let Some(stem) = rest.strip_suffix(".yml") else { return false };
        let Some((name, v)) = stem.split_once('@') else { return false };
        return !name.is_empty() && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && !v.is_empty() && !v.starts_with('0') && v.bytes().all(|b| b.is_ascii_digit());
    }
    if let Some(rest) = path.strip_prefix("data/") {
        let Some(id) = rest.strip_suffix(".yml") else { return false };
        return gestalts_core::yml::valid_key(id);
    }
    false
}

/// Where the agent reads the kit and examples: the agent template, which links the packages' sources.
pub struct Reference {
    template: PathBuf,
}

impl Reference {
    pub fn new(template: PathBuf) -> Self {
        Reference { template }
    }

    /// The contract, from the template's CLAUDE.md, with how it applies here. Fixed text, so it caches.
    pub fn system(&self) -> Result<String, String> {
        let contract = std::fs::read_to_string(self.template.join("CLAUDE.md")).map_err(|e| format!("the agent's contract: {e}"))?;
        Ok(format!("{PREFACE}\n\n{contract}"))
    }

    /// A path under `examples/` or `node_modules/@gestalts/<package>/src/`, as a file there, or `None`.
    fn resolve(&self, path: &str) -> Option<PathBuf> {
        if path.split('/').any(|p| p == ".." || p.is_empty() || p == ".") {
            return None;
        }
        let allowed = path.starts_with("examples/") || path == "examples" || ["view", "kit", "learning", "sources"].iter().any(|p| {
            let root = format!("node_modules/@gestalts/{p}/src");
            path == root || path.starts_with(&format!("{root}/"))
        });
        allowed.then(|| self.template.join(path))
    }

    fn read(&self, path: &str) -> Option<String> {
        let p = self.resolve(path)?;
        let meta = std::fs::metadata(&p).ok()?;
        if !meta.is_file() || meta.len() as usize > MAX_READ_BYTES {
            return None;
        }
        std::fs::read_to_string(p).ok()
    }

    fn list(&self, path: &str) -> Option<Vec<String>> {
        let p = self.resolve(path)?;
        let mut out: Vec<String> = std::fs::read_dir(p).ok()?.flatten().map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if e.path().is_dir() { format!("{path}/{name}/") } else { format!("{path}/{name}") }
        }).collect();
        out.sort();
        Some(out)
    }

    /// Every file under the readable roots, for searching.
    fn files(&self) -> Vec<String> {
        fn walk(dir: &FsPath, rel: &str, out: &mut Vec<String>, depth: usize) {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let r = format!("{rel}/{name}");
                if e.path().is_dir() {
                    if depth < 8 && name != "node_modules" { walk(&e.path(), &r, out, depth + 1); }
                } else if [".ts", ".tsx", ".json", ".yml", ".md"].iter().any(|x| name.ends_with(x)) && !name.contains(".test.") {
                    out.push(r);
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.template.join("examples"), "examples", &mut out, 0);
        for p in ["view", "kit", "learning", "sources"] {
            let root = format!("node_modules/@gestalts/{p}/src");
            walk(&self.template.join(&root), &root, &mut out, 0);
        }
        out.sort();
        out
    }
}

const PREFACE: &str = "\
You are making an interactive learning view for a teacher, for their class. When it's done they publish it, and \
their students open it on school devices (old iPads and Chromebooks among them): keep it light, and make it work \
well with touch and on a small screen. A published view reaches no server: no fetch, no external images or fonts; \
npm packages are bundled and pinned. Speak to the teacher plainly, in the language they write in; they are not \
programmers.

Here the folder below is not a disk: you work on the draft's files through tools. `read_file`, `write_file`, \
`edit_file`, `delete_file` and `list_files` work on `view.tsx`, `view.json`, `gestalts/` and `data/`; the kit's \
sources (`node_modules/@gestalts/<package>/src/…`) and `examples/` can be read and listed, not written; `search` \
finds text in all of them; `check` is the contract's check. There is no shell.";

fn tools() -> Value {
    let path = json!({ "type": "string", "description": "e.g. view.tsx, gestalts/noun@1.yml, data/haus.yml, examples/noun-gender/view.tsx" });
    json!([
        { "name": "list_files", "description": "Lists the draft's files, or with `path` a folder of the kit's sources or examples.",
          "input_schema": { "type": "object", "properties": { "path": path }, "additionalProperties": false } },
        { "name": "read_file", "description": "Reads a file of the draft, the kit's sources or the examples.",
          "input_schema": { "type": "object", "properties": { "path": path }, "required": ["path"], "additionalProperties": false } },
        { "name": "write_file", "description": "Writes a whole file of the draft: view.tsx, view.json, gestalts/<name>@<N>.yml or data/<id>.yml.",
          "input_schema": { "type": "object", "properties": { "path": path, "content": { "type": "string" } }, "required": ["path", "content"], "additionalProperties": false } },
        { "name": "edit_file", "description": "Replaces `old_string` with `new_string` in a file of the draft. `old_string` must occur exactly once, unless `replace_all`.",
          "input_schema": { "type": "object", "properties": { "path": path, "old_string": { "type": "string" }, "new_string": { "type": "string" }, "replace_all": { "type": "boolean" } }, "required": ["path", "old_string", "new_string"], "additionalProperties": false } },
        { "name": "delete_file", "description": "Deletes a file of the draft under gestalts/ or data/.",
          "input_schema": { "type": "object", "properties": { "path": path }, "required": ["path"], "additionalProperties": false } },
        { "name": "search", "description": "Finds lines containing `text` (case-insensitive) in the draft, the kit's sources and the examples; `path` limits it to a folder or file.",
          "input_schema": { "type": "object", "properties": { "text": { "type": "string" }, "path": path }, "required": ["text"], "additionalProperties": false } },
        { "name": "check", "description": "Compiles and typechecks view.tsx as the workshop does, checks view.json, gestalts/ and data/, and that each npm import is pinned in view.json and bundles. Run it before you finish.",
          "input_schema": { "type": "object", "properties": {}, "additionalProperties": false } }
    ])
}

/// The draft's files during a turn, and what the turn may read besides.
struct Workspace<'a> {
    files: BTreeMap<String, String>,
    gestalts: &'a [String],
    reference: &'a Reference,
}

impl Workspace<'_> {
    /// What a tool did, as its result text, or an error the model sees.
    async fn run(&mut self, name: &str, input: &Value, worker: &crate::worker::Worker) -> Result<String, String> {
        let s = |k: &str| input.get(k).and_then(Value::as_str);
        let need = |k: &str| s(k).ok_or_else(|| format!("`{k}` is missing"));
        match name {
            "list_files" => match s("path").filter(|p| !p.is_empty() && *p != ".") {
                None => Ok(self.files.keys().cloned().collect::<Vec<_>>().join("\n")),
                Some(p) => {
                    let p = p.trim_end_matches('/');
                    let mine: Vec<String> = self.files.keys().filter(|f| f.starts_with(&format!("{p}/"))).cloned().collect();
                    if !mine.is_empty() || matches!(p, "gestalts" | "data") {
                        return Ok(mine.join("\n"));
                    }
                    self.reference.list(p).map(|l| l.join("\n")).ok_or_else(|| format!("{p}: no such folder here"))
                }
            },
            "read_file" => {
                let p = need("path")?;
                self.files.get(p).cloned().or_else(|| self.reference.read(p)).ok_or_else(|| format!("{p}: no such file"))
            }
            "write_file" => {
                let (p, content) = (need("path")?, need("content")?);
                if !is_draft_file(p) {
                    return Err(format!("{p}: only view.tsx, view.json, gestalts/<name>@<N>.yml and data/<id>.yml can be written"));
                }
                if content.len() > MAX_FILE_BYTES {
                    return Err(format!("{p}: longer than {MAX_FILE_BYTES} bytes"));
                }
                self.files.insert(p.to_owned(), content.to_owned());
                Ok(format!("wrote {p}"))
            }
            "edit_file" => {
                let (p, old, new) = (need("path")?, need("old_string")?, need("new_string")?);
                let all = input.get("replace_all").and_then(Value::as_bool).unwrap_or(false);
                let text = self.files.get(p).ok_or_else(|| format!("{p}: no such file in the draft"))?;
                let n = text.matches(old).count();
                if old.is_empty() || n == 0 {
                    return Err(format!("{p}: old_string isn't there; read the file again"));
                }
                if n > 1 && !all {
                    return Err(format!("{p}: old_string is there {n} times; give more context, or replace_all"));
                }
                let next = if all { text.replace(old, new) } else { text.replacen(old, new, 1) };
                if next.len() > MAX_FILE_BYTES {
                    return Err(format!("{p}: longer than {MAX_FILE_BYTES} bytes"));
                }
                self.files.insert(p.to_owned(), next);
                Ok(format!("edited {p}"))
            }
            "delete_file" => {
                let p = need("path")?;
                if !(p.starts_with("gestalts/") || p.starts_with("data/")) || self.files.remove(p).is_none() {
                    return Err(format!("{p}: only an existing file under gestalts/ or data/ can be deleted"));
                }
                Ok(format!("deleted {p}"))
            }
            "search" => {
                let text = need("text")?.to_lowercase();
                let scope = s("path").unwrap_or("").trim_end_matches('/');
                let in_scope = |f: &str| scope.is_empty() || f == scope || f.starts_with(&format!("{scope}/"));
                let mut hits = Vec::new();
                let mut search = |f: &str, body: &str| {
                    for (i, line) in body.lines().enumerate() {
                        if hits.len() < 60 && line.to_lowercase().contains(&text) {
                            hits.push(format!("{f}:{}: {}", i + 1, line.trim().chars().take(200).collect::<String>()));
                        }
                    }
                };
                for (f, body) in &self.files {
                    if in_scope(f) { search(f, body); }
                }
                for f in self.reference.files().into_iter().filter(|f| in_scope(f)) {
                    if let Some(body) = self.reference.read(&f) { search(&f, &body); }
                }
                Ok(if hits.is_empty() { "nothing found".into() } else { hits.join("\n") })
            }
            "check" => {
                let (ok, output) = worker.check(&self.files, self.gestalts).await?;
                if ok { Ok(output) } else { Err(output) }
            }
            other => Err(format!("no tool {other}")),
        }
    }
}

fn summary(name: &str, input: &Value) -> String {
    match name {
        "search" => format!("“{}”", input["text"].as_str().unwrap_or_default()),
        "check" => String::new(),
        _ => input["path"].as_str().unwrap_or_default().to_owned(),
    }
}

/// A turn's job: what it did so far, for whoever polls.
pub struct Job {
    pub id: String,
    pub account: String,
    pub draft: String,
    events: Mutex<Vec<Value>>,
    done: AtomicBool,
    cancelled: AtomicBool,
    changed: Notify,
    cancel: Notify,
    finished: Mutex<Option<Instant>>,
}

impl Job {
    fn emit(&self, e: Value) {
        self.events.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(e);
        self.changed.notify_waiters();
    }

    fn finish(&self) {
        *self.finished.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Instant::now());
        self.done.store(true, Ordering::SeqCst);
        self.changed.notify_waiters();
    }
}

/// A conversation, kept between turns: its messages and the files as it last left them.
struct Session {
    account: String,
    draft: String,
    messages: Vec<Value>,
    files: BTreeMap<String, String>,
    touched: Instant,
}

/// How the agent reaches the model.
#[derive(Clone)]
pub struct Model {
    pub api_key: Option<String>,
    pub base_url: String,
    pub model: String,
}

pub struct Agents {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    sessions: Mutex<HashMap<String, Session>>,
    http: reqwest::Client,
    pub model: Model,
    pub reference: Reference,
    system: Result<String, String>,
}

impl Agents {
    pub fn new(model: Model, reference: Reference) -> Self {
        let system = reference.system();
        let http = reqwest::Client::builder().timeout(Duration::from_secs(600)).build().expect("an HTTP client");
        Agents { jobs: Mutex::default(), sessions: Mutex::default(), http, model, reference, system }
    }

    fn prune(&self) {
        self.jobs.lock().unwrap_or_else(std::sync::PoisonError::into_inner).retain(|_, j| {
            j.finished.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_none_or(|t| t.elapsed() < FINISHED_KEEP)
        });
        self.sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner).retain(|_, s| s.touched.elapsed() < SESSION_KEEP);
    }

    /// Why the agent can't take a turn now, if it can't.
    fn unavailable(&self) -> Option<String> {
        if self.model.api_key.is_none() {
            return Some("the agent isn't set up on this server (no API key)".into());
        }
        self.system.as_ref().err().cloned()
    }

    async fn call_model(&self, system: &str, messages: &[Value]) -> Result<Value, String> {
        let body = json!({
            "model": self.model.model,
            "max_tokens": MAX_TOKENS,
            // thinking is always on for this model; effort decides how much
            "output_config": { "effort": "high" },
            "system": [{ "type": "text", "text": system, "cache_control": { "type": "ephemeral" } }],
            "tools": tools(),
            "messages": messages,
            // the conversation so far, cached as it grows
            "cache_control": { "type": "ephemeral" },
            // a request a safety classifier declines is retried on the model that fits, in the same call
            "fallbacks": "default",
        });
        let mut wait = Duration::from_secs(2);
        for attempt in 0..4 {
            let res = self
                .http
                .post(format!("{}/v1/messages", self.model.base_url.trim_end_matches('/')))
                .header("x-api-key", self.model.api_key.as_deref().unwrap_or_default())
                .header("anthropic-version", API_VERSION)
                .header("anthropic-beta", FALLBACK_BETA)
                .json(&body)
                .send()
                .await;
            let retry = match res {
                Ok(r) if r.status().is_success() => return r.json::<Value>().await.map_err(|e| format!("the model's answer: {e}")),
                Ok(r) => {
                    let status = r.status();
                    let should = r.headers().get("x-should-retry").and_then(|v| v.to_str().ok()).map(|v| v == "true");
                    let text = r.text().await.unwrap_or_default();
                    let message = serde_json::from_str::<Value>(&text).ok().and_then(|v| v["error"]["message"].as_str().map(str::to_owned)).unwrap_or(text);
                    let retryable = should.unwrap_or(status.as_u16() == 429 || status.as_u16() == 408 || status.as_u16() == 409 || status.is_server_error());
                    if !retryable || attempt == 3 {
                        return Err(format!("the model answered {status}: {message}"));
                    }
                    message
                }
                Err(e) if attempt == 3 => return Err(format!("reaching the model: {e}")),
                Err(e) => e.to_string(),
            };
            eprintln!("agent: retrying a model call ({retry})");
            tokio::time::sleep(wait).await;
            wait *= 2;
        }
        unreachable!("the last attempt returns")
    }
}

/// An assistant turn as it may be sent back: after a fallback mid-answer, what the declining model started (its
/// thinking and tool calls) is left out before the last `fallback` block, which stays where it was.
fn echoable(content: &[Value]) -> Vec<Value> {
    let Some(last) = content.iter().rposition(|b| b["type"] == "fallback") else { return content.to_vec() };
    content
        .iter()
        .enumerate()
        .filter(|(i, b)| *i >= last || !matches!(b["type"].as_str(), Some("thinking" | "redacted_thinking" | "tool_use" | "server_tool_use")))
        .map(|(_, b)| b.clone())
        .collect()
}

#[derive(Deserialize)]
pub struct TurnRequest {
    view: String,
    session: Option<String>,
    message: String,
    files: BTreeMap<String, String>,
    #[serde(default)]
    gestalts: Vec<String>,
    #[serde(default)]
    diagnostics: Vec<Value>,
}

/// The first instant of this calendar month, as the budget counts.
fn month_start() -> String {
    format!("{}-01T00:00:00.000Z", &now_iso()[..7])
}

async fn status(State(state): State<AppState>, teacher: Teacher, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    state.own_draft(&teacher, &id)?;
    let reason = match state.agents.unavailable() {
        Some(r) => Some(r),
        None if state.db.tokens_since(&teacher.0.id, &month_start())? >= teacher.0.token_budget => Some("this month's budget for the agent is used up".into()),
        None => None,
    };
    Ok(Json(match reason {
        Some(r) => json!({ "available": false, "reason": r }),
        None => json!({ "available": true }),
    }))
}

async fn turn(State(state): State<AppState>, teacher: Teacher, Path(id): Path<String>, Json(req): Json<TurnRequest>) -> ApiResult<(StatusCode, Json<Value>)> {
    let (draft, _) = state.own_draft(&teacher, &id)?;
    if req.view != draft.id {
        return Err(ApiError::BadRequest("view: not this draft".into()));
    }
    if req.message.trim().is_empty() {
        return Err(ApiError::BadRequest("message is empty".into()));
    }
    if let Some(p) = req.files.keys().find(|p| !is_draft_file(p)) {
        return Err(ApiError::BadRequest(format!("files: {p} isn't part of a draft")));
    }
    if let Some(r) = state.agents.unavailable() {
        return Err(ApiError::Conflict(r));
    }
    if state.db.tokens_since(&teacher.0.id, &month_start())? >= teacher.0.token_budget {
        return Err(ApiError::TooMany("this month's budget for the agent is used up".into()));
    }
    state.agents.prune();
    let job = {
        let mut jobs = state.agents.jobs.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if jobs.values().any(|j| j.account == teacher.0.id && !j.done.load(Ordering::SeqCst)) {
            return Err(ApiError::Conflict("a turn is already running: wait for it, or stop it".into()));
        }
        let job = Arc::new(Job {
            id: random_hex(16),
            account: teacher.0.id.clone(),
            draft: draft.id.clone(),
            events: Mutex::default(),
            done: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            changed: Notify::new(),
            cancel: Notify::new(),
            finished: Mutex::new(None),
        });
        jobs.insert(job.id.clone(), job.clone());
        job
    };
    state.db.add_turn(&job.id, &teacher.0.id, &draft.id, &now_iso())?;
    let id = job.id.clone();
    tokio::spawn(run_turn(state.clone(), job, req));
    Ok((StatusCode::ACCEPTED, Json(json!({ "job": id }))))
}

/// The user's message, with what changed since the agent last saw the draft and what went wrong meanwhile.
fn opening(req: &TurnRequest, last: Option<&BTreeMap<String, String>>) -> String {
    let mut text = req.message.clone();
    if let Some(last) = last {
        let changed: Vec<&String> = last.keys().chain(req.files.keys()).filter(|p| last.get(*p) != req.files.get(*p)).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
        if !changed.is_empty() {
            text.push_str(&format!("\n\n(Changed since your last turn, outside this conversation: {}. Read them again before relying on what you remember.)", changed.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")));
        }
    } else {
        text.push_str(&format!("\n\n(The draft's files now: {}.)", req.files.keys().cloned().collect::<Vec<_>>().join(", ")));
    }
    if !req.diagnostics.is_empty() {
        text.push_str("\n\n(Since your last turn the preview reported these errors, or saving refused these files. Fix them first.)");
        for d in req.diagnostics.iter().take(20) {
            let stack = d["stack"].as_str().map(|s| s.lines().take(8).collect::<Vec<_>>().join("\n")).unwrap_or_default();
            text.push_str(&format!("\n- {}: {}{}", d["kind"].as_str().unwrap_or("error"), d["message"].as_str().unwrap_or_default(), if stack.is_empty() { String::new() } else { format!("\n  {stack}") }));
        }
    }
    text
}

async fn run_turn(state: AppState, job: Arc<Job>, req: TurnRequest) {
    let agents = &state.agents;
    let session_id = req.session.clone().filter(|s| {
        agents.sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(s).is_some_and(|s| s.account == job.account && s.draft == job.draft)
    });
    let (session_id, mut messages, last) = match session_id {
        Some(id) => {
            let s = agents.sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&id).expect("just seen");
            (id, s.messages, Some(s.files))
        }
        None => (random_hex(16), Vec::new(), None),
    };
    let before = messages.len();
    messages.push(json!({ "role": "user", "content": [{ "type": "text", "text": opening(&req, last.as_ref()) }] }));
    let mut ws = Workspace { files: req.files.clone(), gestalts: &req.gestalts, reference: &agents.reference };
    let system = agents.system.clone().unwrap_or_default();

    let outcome: Result<(), String> = async {
        for _ in 0..MAX_STEPS {
            if job.cancelled.load(Ordering::SeqCst) {
                return Err("stopped".into());
            }
            let resp = tokio::select! {
                r = agents.call_model(&system, &messages) => r?,
                () = job.cancel.notified() => return Err("stopped".into()),
            };
            let u = &resp["usage"];
            let n = |k: &str| u[k].as_i64().unwrap_or(0);
            let _ = state.db.add_usage(&job.id, n("input_tokens"), n("output_tokens"), n("cache_read_input_tokens"), n("cache_creation_input_tokens"));
            let stop = resp["stop_reason"].as_str().unwrap_or_default().to_owned();
            if stop == "refusal" {
                return Err("The agent declined this request. Try putting it differently.".into());
            }
            let content = echoable(resp["content"].as_array().map(Vec::as_slice).unwrap_or_default());
            for b in &content {
                if b["type"] == "text" && b["text"].as_str().is_some_and(|t| !t.trim().is_empty()) {
                    job.emit(json!({ "type": "text", "text": b["text"] }));
                }
            }
            if !content.is_empty() {
                messages.push(json!({ "role": "assistant", "content": content }));
            }
            match stop.as_str() {
                "tool_use" => {
                    let mut results = Vec::new();
                    for b in content.iter().filter(|b| b["type"] == "tool_use") {
                        let name = b["name"].as_str().unwrap_or_default();
                        job.emit(json!({ "type": "tool", "name": name, "summary": summary(name, &b["input"]) }));
                        let r = ws.run(name, &b["input"], &state.worker).await;
                        let (text, is_error) = match r { Ok(t) => (t, false), Err(t) => (t, true) };
                        results.push(json!({ "type": "tool_result", "tool_use_id": b["id"], "content": text, "is_error": is_error }));
                    }
                    messages.push(json!({ "role": "user", "content": results }));
                }
                // the server paused a long turn: send it back as it is to go on
                "pause_turn" => {}
                "max_tokens" => return Err("The agent's answer got too long and was cut off. Ask for a smaller step.".into()),
                _ => return Ok(()),
            }
        }
        Err(format!("The turn took more than {MAX_STEPS} steps and was stopped. Ask for a smaller step."))
    }
    .await;

    // the files are the work: they come back whether or not the turn ended well
    let changed: BTreeMap<String, Value> = ws.files.iter().filter(|(p, t)| req.files.get(*p) != Some(*t)).map(|(p, t)| (p.clone(), json!(t)))
        .chain(req.files.keys().filter(|p| !ws.files.contains_key(*p)).map(|p| (p.clone(), Value::Null)))
        .collect();
    if !changed.is_empty() {
        job.emit(json!({ "type": "files", "files": changed }));
    }
    match outcome {
        Ok(()) => {}
        Err(e) => {
            // the conversation goes on from before this turn: what's left of it may not be a valid one
            messages.truncate(before);
            job.emit(json!({ "type": "error", "message": e }));
        }
    }
    let files = ws.files;
    agents.sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(session_id.clone(), Session {
        account: job.account.clone(),
        draft: job.draft.clone(),
        messages,
        files,
        touched: Instant::now(),
    });
    job.emit(json!({ "type": "done", "session": session_id }));
    job.finish();
}

#[derive(Deserialize)]
struct EventsQuery {
    job: String,
    #[serde(default)]
    after: usize,
}

fn own_job(state: &AppState, teacher: &Teacher, job: &str) -> ApiResult<Arc<Job>> {
    state.agents.jobs.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(job).filter(|j| j.account == teacher.0.id).cloned().ok_or(ApiError::NotFound)
}

async fn events(State(state): State<AppState>, teacher: Teacher, Path(_id): Path<String>, Query(q): Query<EventsQuery>) -> ApiResult<Json<Value>> {
    let job = own_job(&state, &teacher, &q.job)?;
    let deadline = Instant::now() + EVENT_POLL;
    loop {
        let changed = job.changed.notified();
        {
            let events = job.events.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let done = job.done.load(Ordering::SeqCst);
            if events.len() > q.after || done {
                let page: Vec<Value> = events.iter().skip(q.after).cloned().collect();
                return Ok(Json(json!({ "events": page, "next": events.len(), "done": done })));
            }
        }
        if tokio::time::timeout(deadline.saturating_duration_since(Instant::now()), changed).await.is_err() {
            return Ok(Json(json!({ "events": [], "next": q.after, "done": false })));
        }
    }
}

#[derive(Deserialize)]
struct Cancel {
    job: String,
}

async fn cancel(State(state): State<AppState>, teacher: Teacher, Path(_id): Path<String>, Json(req): Json<Cancel>) -> ApiResult<Json<Value>> {
    let job = own_job(&state, &teacher, &req.job)?;
    job.cancelled.store(true, Ordering::SeqCst);
    job.cancel.notify_waiters();
    Ok(Json(json!({})))
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/drafts/{id}/agent/status", get(status))
        .route("/drafts/{id}/agent/turn", post(turn))
        .route("/drafts/{id}/agent/events", get(events))
        .route("/drafts/{id}/agent/cancel", post(cancel))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draft_files() {
        for ok in ["view.tsx", "view.json", "gestalts/noun@1.yml", "data/haus.yml"] {
            assert!(is_draft_file(ok), "{ok}");
        }
        for bad in ["notes.md", "gestalts/Noun@1.yml", "gestalts/noun@01.yml", "data/../x.yml", "data/a/b.yml", "node_modules/x.ts"] {
            assert!(!is_draft_file(bad), "{bad}");
        }
    }

    #[test]
    fn what_comes_before_a_fallback_is_left_out_but_the_fallback_stays() {
        let content = vec![json!({"type": "thinking", "thinking": ""}), json!({"type": "text", "text": "a"}), json!({"type": "tool_use", "id": "x"}), json!({"type": "fallback"}), json!({"type": "thinking"}), json!({"type": "tool_use", "id": "y"})];
        let kept: Vec<String> = echoable(&content).iter().map(|b| b["type"].as_str().unwrap().to_owned()).collect();
        assert_eq!(kept, ["text", "fallback", "thinking", "tool_use"]);
        assert_eq!(echoable(&content[..3]).len(), 3);
    }

    #[test]
    fn the_reference_stays_in_its_roots() {
        let r = Reference::new(PathBuf::from("/t"));
        assert!(r.resolve("examples/noun-gender/view.tsx").is_some());
        assert!(r.resolve("node_modules/@gestalts/kit/src/index.ts").is_some());
        for bad in ["node_modules/react/index.js", "examples/../check.ts", "/etc/passwd", "node_modules/@gestalts/kit/package.json", "CLAUDE.md"] {
            assert!(r.resolve(bad).is_none(), "{bad}");
        }
    }
}
