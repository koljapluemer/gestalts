//! One turn: the page's files laid out in a workspace, `claude -p` run there with the page's tools (through the MCP
//! shim, `mcp.rs`), what it says and does streamed back, then the files it changed. The workspace is the page's:
//! everything in it is replaced by what each turn sends, so the draft in the page stays the truth.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

/// What the page sends.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FromPage {
    Start(Box<Start>),
    ToolResult {
        id: String,
        #[serde(default)]
        content: Vec<Value>,
        #[serde(default, rename = "isError")]
        is_error: bool,
    },
    Cancel,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Start {
    /// the page's name for this workspace (a draft's id); a session resumes only in its own workspace
    pub workspace: String,
    pub session: Option<String>,
    pub prompt: String,
    /// appended to Claude Code's system prompt
    pub system: Option<String>,
    /// text files by path
    #[serde(default)]
    pub files: BTreeMap<String, String>,
    /// other files by path, as base64
    #[serde(default)]
    pub binary: BTreeMap<String, String>,
    /// which paths are the draft (a regex matching the whole path): what tools see and what comes back
    pub keep: String,
    #[serde(default)]
    pub tools: Vec<ToolSpec>,
    pub model: Option<String>,
    pub max_budget_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub input_schema: Value,
}

/// What the page hears.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToPage {
    Text { text: String },
    Tool { name: String, summary: String },
    ToolCall { id: String, name: String, input: Value, files: BTreeMap<String, String> },
    /// the files the turn changed; `null`: deleted
    Files { files: BTreeMap<String, Option<String>> },
    Done { session: Option<String> },
    Error { message: String },
}

const WORKSPACE_ID: &str = r"^[a-z0-9][a-z0-9-]{0,63}$";
const TOOL_NAME: &str = r"^[a-z][a-z0-9_]{0,39}$";
const MAX_PATH: usize = 300;
const MAX_FILES: usize = 4000;
/// the bridge's own files in a workspace, kept between turns
const OWN: &str = ".bridge";
/// Claude may read and edit only the workspace, and run nothing but the page's tools
const CLAUDE_TOOLS: &[&str] = &["Read(./**)", "Edit(./**)", "Write(./**)", "Glob", "Grep"];
pub const MCP_SERVER: &str = "gestalts";

/// A request the bridge refuses.
pub fn validate(s: &Start) -> Result<Regex, String> {
    if !Regex::new(WORKSPACE_ID).expect("valid").is_match(&s.workspace) {
        return Err("workspace: lowercase letters, digits and -, at most 64".into());
    }
    if s.prompt.trim().is_empty() { return Err("the prompt is empty".into()); }
    if s.files.len() + s.binary.len() > MAX_FILES { return Err(format!("more than {MAX_FILES} files")); }
    for p in s.files.keys().chain(s.binary.keys()) {
        if !safe_path(p) { return Err(format!("not a path inside the workspace: {p:?}")); }
    }
    let name = Regex::new(TOOL_NAME).expect("valid");
    let mut seen = BTreeSet::new();
    for t in &s.tools {
        if !name.is_match(&t.name) || !seen.insert(&t.name) { return Err(format!("tool name {:?}: lowercase letters, digits and _, once each", t.name)); }
        if !t.input_schema.is_object() { return Err(format!("tool {}: inputSchema must be a JSON schema object", t.name)); }
    }
    if let Some(m) = &s.model && !m.chars().all(|c| c.is_ascii_alphanumeric() || "-._[]".contains(c)) {
        return Err("model: a model name, like sonnet or claude-sonnet-4-5".into());
    }
    if s.max_budget_usd.is_some_and(|b| !(b > 0.0 && b.is_finite())) { return Err("maxBudgetUsd must be positive".into()); }
    Regex::new(&format!("^(?:{})$", s.keep)).map_err(|e| format!("keep: {e}"))
}

/// A relative path with plain parts, not into the bridge's own folder.
pub fn safe_path(p: &str) -> bool {
    !p.is_empty() && p.len() <= MAX_PATH && !p.starts_with('/') && !p.contains('\\') && !p.contains(':') && !p.contains('\0')
        && p.split('/').all(|c| !c.is_empty() && c != "." && c != "..")
        && p.split('/').next() != Some(OWN)
}

/// The turn as it runs: what the internal endpoint needs to hand a tool call to the page.
pub struct Live {
    pub secret: String,
    pub tools: Vec<ToolSpec>,
    pub workspace: PathBuf,
    pub keep: Regex,
    pub out: mpsc::UnboundedSender<ToPage>,
    pub pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
}

impl Live {
    /// Asks the page to run a tool on the draft as it is now; the MCP result (`{content, isError}`).
    pub async fn call(&self, name: &str, input: Value) -> Value {
        if !self.tools.iter().any(|t| t.name == name) { return tool_error(format!("no tool {name}")); }
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().expect("pending lock").insert(id.clone(), tx);
        let files = collect(&self.workspace, &self.keep);
        if self.out.send(ToPage::ToolCall { id: id.clone(), name: name.to_owned(), input, files }).is_err() {
            self.pending.lock().expect("pending lock").remove(&id);
            return tool_error("the page is gone".into());
        }
        match tokio::time::timeout(std::time::Duration::from_secs(600), rx).await {
            Ok(Ok(v)) => v,
            _ => {
                self.pending.lock().expect("pending lock").remove(&id);
                tool_error(format!("the page didn't answer {name}"))
            }
        }
    }

    /// The page's answer to a call.
    pub fn answer(&self, id: &str, content: Vec<Value>, is_error: bool) {
        if let Some(tx) = self.pending.lock().expect("pending lock").remove(id) {
            let _ = tx.send(json!({ "content": content, "isError": is_error }));
        }
    }
}

pub fn tool_error(message: String) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}

/// Lays out the workspace for a turn: everything but the bridge's own folder replaced by what the page sent.
/// Returns the draft's files that differ from how the last turn left them (changed outside the conversation).
pub fn prepare(dir: &Path, start: &Start, keep: &Regex) -> Result<Vec<String>, String> {
    use base64::Engine;
    std::fs::create_dir_all(dir.join(OWN)).map_err(|e| e.to_string())?;
    let last: BTreeMap<String, String> = std::fs::read(dir.join(OWN).join("last.json")).ok()
        .and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let now: BTreeMap<&String, &String> = start.files.iter().filter(|(p, _)| keep.is_match(p)).collect();
    let outside: Vec<String> = last.keys().chain(now.keys().copied()).collect::<BTreeSet<_>>().into_iter()
        .filter(|p| last.get(*p) != now.get(*p).copied()).cloned().collect();
    for e in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        if e.file_name() == OWN { continue; }
        let p = e.path();
        let removed = if e.file_type().map(|t| t.is_dir()).unwrap_or(false) { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
        removed.map_err(|e| format!("cannot clear {}: {e}", p.display()))?;
    }
    let write = |path: &str, bytes: &[u8]| -> Result<(), String> {
        let to = dir.join(path);
        if let Some(parent) = to.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        std::fs::write(&to, bytes).map_err(|e| format!("cannot write {path}: {e}"))
    };
    for (path, text) in &start.files { write(path, text.as_bytes())?; }
    for (path, b64) in &start.binary {
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| format!("{path}: not base64: {e}"))?;
        write(path, &bytes)?;
    }
    Ok(outside)
}

/// The draft's files in the workspace now (those `keep` matches), as text.
pub fn collect(dir: &Path, keep: &Regex) -> BTreeMap<String, String> {
    fn walk(dir: &Path, rel: &str, keep: &Regex, out: &mut BTreeMap<String, String>, depth: usize) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if rel.is_empty() && name == OWN { continue; }
            let path = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            let Ok(t) = e.file_type() else { continue };
            if t.is_dir() && depth < 8 { walk(&e.path(), &path, keep, out, depth + 1); }
            else if t.is_file() && keep.is_match(&path) && let Ok(text) = std::fs::read_to_string(e.path()) {
                out.insert(path, text);
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, "", keep, &mut out, 0);
    out
}

/// How the bridge runs claude for one turn.
pub struct Command {
    pub claude: PathBuf,
    /// `--mcp-config`: a file
    pub mcp_config: PathBuf,
}

pub fn args(start: &Start, mcp_config: &Path) -> Vec<String> {
    let mut a: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--mcp-config"]
        .map(String::from).into();
    a.push(mcp_config.display().to_string());
    if let Some(s) = &start.system { a.extend(["--append-system-prompt".into(), s.clone()]); }
    if let Some(s) = &start.session { a.extend(["--resume".into(), s.clone()]); }
    if let Some(m) = &start.model { a.extend(["--model".into(), m.clone()]); }
    if let Some(b) = start.max_budget_usd { a.extend(["--max-budget-usd".into(), format!("{b}")]); }
    a.push("--allowedTools".into());
    a.extend(CLAUDE_TOOLS.iter().map(|t| t.to_string()));
    a.extend(start.tools.iter().map(|t| format!("mcp__{MCP_SERVER}__{}", t.name)));
    a
}

/// What the page sees of a tool use: its name and a short summary.
pub fn summary(name: &str, input: &Value, workspace: &Path) -> (String, String) {
    let name = name.strip_prefix(&format!("mcp__{MCP_SERVER}__")).unwrap_or(name).to_owned();
    let root = format!("{}/", workspace.display());
    for key in ["file_path", "path"] {
        if let Some(p) = input.get(key).and_then(Value::as_str) {
            return (name, p.strip_prefix(&root).unwrap_or(p).to_owned());
        }
    }
    for key in ["command", "pattern"] {
        if let Some(s) = input.get(key).and_then(Value::as_str) { return (name, s.chars().take(200).collect()); }
    }
    (name, String::new())
}

/// What one line of claude's stream says, for the page; `session` and `failed` are updated from it.
pub fn events_of(e: &Value, workspace: &Path, session: &mut Option<String>, failed: &mut Option<String>) -> Vec<ToPage> {
    let mut out = vec![];
    match e.get("type").and_then(Value::as_str) {
        Some("system") if e.get("subtype").and_then(Value::as_str) == Some("init") => {
            if let Some(s) = e.get("session_id").and_then(Value::as_str) { *session = Some(s.to_owned()); }
        }
        Some("assistant") => {
            for c in e.pointer("/message/content").and_then(Value::as_array).into_iter().flatten() {
                match c.get("type").and_then(Value::as_str) {
                    Some("text") => if let Some(t) = c.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                        out.push(ToPage::Text { text: t.to_owned() });
                    },
                    Some("tool_use") => {
                        let (name, summary) = summary(c.get("name").and_then(Value::as_str).unwrap_or(""), c.get("input").unwrap_or(&Value::Null), workspace);
                        out.push(ToPage::Tool { name, summary });
                    }
                    _ => {}
                }
            }
        }
        Some("result") => {
            if let Some(s) = e.get("session_id").and_then(Value::as_str) { *session = Some(s.to_owned()); }
            if e.get("is_error").and_then(Value::as_bool) == Some(true) {
                *failed = Some(e.get("result").and_then(Value::as_str).or_else(|| e.get("subtype").and_then(Value::as_str))
                    .unwrap_or("claude reported an error").to_owned());
            }
            for d in e.get("permission_denials").and_then(Value::as_array).into_iter().flatten() {
                let (name, what) = summary(d.get("tool_name").and_then(Value::as_str).unwrap_or("?"), d.get("tool_input").unwrap_or(&Value::Null), workspace);
                out.push(ToPage::Tool { name, summary: format!("(not allowed here) {what}").trim().to_owned() });
            }
        }
        _ => {}
    }
    out
}

/// Runs one turn to its end, telling the page as it goes. `cancel` stops claude.
pub async fn run(cmd: Command, start: Start, live: Arc<Live>, runs: PathBuf, outside: Vec<String>, mut cancel: oneshot::Receiver<()>) {
    let out = live.out.clone();
    let workspace = live.workspace.clone();
    let input: BTreeMap<String, String> = start.files.iter().filter(|(p, _)| live.keep.is_match(p)).map(|(p, t)| (p.clone(), t.clone())).collect();
    let mut log = RunLog::new(&runs, &start, &input);
    let mut session = start.session.clone();
    let mut failed: Option<String> = None;
    let mut cancelled = false;
    let mut exit_code = None;

    let mut prompt = start.prompt.clone();
    if start.session.is_some() && !outside.is_empty() {
        prompt.push_str(&format!("\n\n(Changed since your last turn, outside this conversation: {}. Re-read them before relying on what you remember.)", outside.join(", ")));
    }
    let mut child = match tokio::process::Command::new(&cmd.claude).args(args(&start, &cmd.mcp_config)).current_dir(&workspace)
        .env("MCP_TOOL_TIMEOUT", "900000").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn() {
        Ok(c) => c,
        Err(e) => {
            let message = format!("cannot run {}: {e}", cmd.claude.display());
            log.finish("failed", None, None, 0, Some(&message));
            let _ = out.send(ToPage::Error { message });
            let _ = out.send(ToPage::Done { session: start.session });
            return;
        }
    };
    // the prompt on stdin, so no flag can take it for one of its values
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes()).await;
    }
    let mut stderr = child.stderr.take().expect("piped");
    let stderr_task = tokio::spawn(async move {
        let mut s = String::new();
        let _ = (&mut stderr).take(256 * 1024).read_to_string(&mut s).await;
        s
    });
    let mut lines = BufReader::new(child.stdout.take().expect("piped")).lines();
    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(line)) => match serde_json::from_str::<Value>(&line) {
                    Ok(e) => {
                        log.event(&e);
                        for ev in events_of(&e, &workspace, &mut session, &mut failed) { let _ = out.send(ev); }
                    }
                    Err(_) => log.malformed(&line),
                },
                _ => break,
            },
            _ = &mut cancel, if !cancelled => {
                cancelled = true;
                let _ = child.start_kill();
            }
        }
    }
    if let Ok(status) = child.wait().await { exit_code = status.code(); }
    let stderr = stderr_task.await.unwrap_or_default();
    log.stderr(stderr.trim());
    if !cancelled && exit_code != Some(0) && failed.is_none() {
        let tail: String = stderr.trim().chars().rev().take(2000).collect::<Vec<_>>().into_iter().rev().collect();
        failed = Some(format!("claude exited with {}{}", exit_code.map_or("a signal".into(), |c| c.to_string()),
                              if tail.is_empty() { String::new() } else { format!(": {tail}") }));
    }
    let after = collect(&workspace, &live.keep);
    let _ = std::fs::write(workspace.join(OWN).join("last.json"), serde_json::to_vec(&after).unwrap_or_default());
    let mut changed: BTreeMap<String, Option<String>> = after.iter().filter(|(p, t)| input.get(*p) != Some(t)).map(|(p, t)| (p.clone(), Some(t.clone()))).collect();
    changed.extend(input.keys().filter(|p| !after.contains_key(*p)).map(|p| (p.clone(), None)));
    let changed_count = changed.len();
    if !changed.is_empty() { let _ = out.send(ToPage::Files { files: changed }); }
    if cancelled { let _ = out.send(ToPage::Error { message: "stopped".into() }); }
    else if let Some(f) = &failed { let _ = out.send(ToPage::Error { message: f.clone() }); }
    let outcome = if cancelled { "cancelled" } else if failed.is_some() { "failed" } else { "completed" };
    log.finish(outcome, session.as_deref(), exit_code, changed_count, failed.as_deref());
    let _ = out.send(ToPage::Done { session });
}

/// A durable record of each turn: the raw stream, and one summary line a day (`workshop-agent-run@2`, which
/// `scripts/agent_stats.py` reads).
pub struct RunLog {
    root: PathBuf,
    run_id: String,
    workspace: String,
    session_in: Option<String>,
    started_at: String,
    started: Instant,
    first_output_ms: Option<u128>,
    result: Value,
    tools: BTreeMap<String, u64>,
    check_ids: BTreeSet<String>,
    check: &'static str,
    request: Value,
    raw: PathBuf,
}

impl RunLog {
    fn new(root: &Path, start: &Start, input: &BTreeMap<String, String>) -> RunLog {
        let run_id = uuid::Uuid::new_v4().simple().to_string();
        let started_at = now();
        let day = started_at[..10].to_owned();
        RunLog {
            root: root.to_owned(),
            raw: root.join("raw").join(&day).join(format!("{run_id}.jsonl")),
            run_id,
            workspace: start.workspace.clone(),
            session_in: start.session.clone(),
            started_at,
            started: Instant::now(),
            first_output_ms: None,
            result: Value::Null,
            tools: BTreeMap::new(),
            check_ids: BTreeSet::new(),
            check: "not_run",
            request: json!({
                "message_chars": start.prompt.chars().count(),
                "files": input.len(),
                "file_chars": input.values().map(|t| t.chars().count()).sum::<usize>(),
                "resumed": start.session.is_some(),
            }),
        }
    }

    fn raw(&self, payload: Value) {
        let mut envelope = json!({ "received_at": now(), "elapsed_ms": self.started.elapsed().as_millis() });
        if let (Some(e), Value::Object(p)) = (envelope.as_object_mut(), payload) { e.extend(p); }
        let _ = append(&self.raw, &envelope);
    }

    fn event(&mut self, e: &Value) {
        self.raw(json!({ "stream": "stdout", "event": e }));
        match e.get("type").and_then(Value::as_str) {
            Some("assistant") => {
                self.first_output_ms.get_or_insert(self.started.elapsed().as_millis());
                for c in e.pointer("/message/content").and_then(Value::as_array).into_iter().flatten() {
                    if c.get("type").and_then(Value::as_str) != Some("tool_use") { continue; }
                    let name = c.get("name").and_then(Value::as_str).unwrap_or("unknown");
                    *self.tools.entry(name.to_owned()).or_default() += 1;
                    if name == format!("mcp__{MCP_SERVER}__check") && let Some(id) = c.get("id").and_then(Value::as_str) {
                        self.check_ids.insert(id.to_owned());
                        self.check = "failed";
                    }
                }
            }
            Some("user") => {
                for c in e.pointer("/message/content").and_then(Value::as_array).into_iter().flatten() {
                    if c.get("type").and_then(Value::as_str) == Some("tool_result")
                        && c.get("tool_use_id").and_then(Value::as_str).is_some_and(|id| self.check_ids.contains(id)) {
                        self.check = if c.get("is_error").and_then(Value::as_bool) == Some(true) { "failed" } else { "passed" };
                    }
                }
            }
            Some("result") => self.result = e.clone(),
            _ => {}
        }
    }

    fn malformed(&self, line: &str) { self.raw(json!({ "stream": "stdout", "unparsed": line })); }

    fn stderr(&self, text: &str) {
        if !text.is_empty() { self.raw(json!({ "stream": "stderr", "text": text })); }
    }

    fn finish(&self, outcome: &str, session: Option<&str>, exit_code: Option<i32>, changed_files: usize, error: Option<&str>) {
        let r = &self.result;
        let mut timings = json!({ "wall_ms": self.started.elapsed().as_millis() });
        if let Some(v) = r.get("duration_ms").filter(|v| v.is_number()) { timings["provider_ms"] = v.clone(); }
        if let Some(v) = self.first_output_ms { timings["first_output_ms"] = json!(v); }
        let mut usage = serde_json::Map::new();
        for (from, to) in [("input_tokens", "input_tokens"), ("output_tokens", "output_tokens"),
                           ("cache_read_input_tokens", "cache_read_tokens"), ("cache_creation_input_tokens", "cache_creation_tokens")] {
            if let Some(v) = r.pointer(&format!("/usage/{from}")).filter(|v| v.is_number()) { usage.insert(to.into(), v.clone()); }
        }
        let raw = self.raw.strip_prefix(&self.root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
        let mut record = json!({
            "schema": "workshop-agent-run@2",
            "run_id": self.run_id,
            "session_in": self.session_in,
            "session_out": session,
            "view": self.workspace,
            "backend": "claude-cli",
            "started_at": self.started_at,
            "finished_at": now(),
            "outcome": outcome,
            "timings": timings,
            "tools": self.tools,
            "request": self.request,
            "result": { "exit_code": exit_code, "changed_files": changed_files, "error": error },
            "verification": { "check": self.check },
            "warnings": { "permission_denials": r.get("permission_denials").and_then(Value::as_array).map_or(0, Vec::len) },
            "raw": raw,
        });
        if !usage.is_empty() { record["usage"] = Value::Object(usage); }
        if let Some(v) = r.get("num_turns").filter(|v| v.is_number()) { record["turns"] = v.clone(); }
        let mut totals = serde_json::Map::new();
        for (from, to) in [("duration_api_ms", "api_ms"), ("total_cost_usd", "cost_usd")] {
            if let Some(v) = r.get(from).filter(|v| v.is_number()) { totals.insert(to.into(), v.clone()); }
        }
        if let Some(m) = r.get("modelUsage").filter(|v| v.is_object()) { totals.insert("models".into(), m.clone()); }
        if !totals.is_empty() { record["session_totals"] = Value::Object(totals); }
        if let Err(e) = append(&self.root.join(format!("{}.jsonl", &self.started_at[..10])), &record) {
            eprintln!("gestalts-claude-bridge: cannot write the run log: {e}");
        }
    }
}

fn append(path: &Path, v: &Value) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(f, "{}", serde_json::to_string(v).unwrap_or_default())
}

/// Now, as RFC 3339 in UTC, without a date library.
fn now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs()) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // days since 1970-01-01 to a civil date (Howard Hinnant's algorithm)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start(files: &[(&str, &str)]) -> Start {
        Start {
            workspace: "draft-1".into(), session: None, prompt: "hi".into(), system: None,
            files: files.iter().map(|(p, t)| (p.to_string(), t.to_string())).collect(), binary: BTreeMap::new(),
            keep: r"view\.tsx|data/[^/]+\.yml".into(), tools: vec![], model: None, max_budget_usd: None,
        }
    }

    #[test]
    fn refuses_paths_outside_the_workspace() {
        for bad in ["", "/etc/passwd", "../x", "a/../b", "a//b", "./a", "C:/x", "a\\b", ".bridge/last.json"] {
            assert!(!safe_path(bad), "{bad:?}");
        }
        for good in ["view.tsx", "data/a.yml", "node_modules/@gestalts/kit/src/index.ts", ".workshop/x"] {
            assert!(safe_path(good), "{good:?}");
        }
        let mut s = start(&[("../x", "")]);
        assert!(validate(&s).is_err());
        s = start(&[]);
        s.workspace = "Nope".into();
        assert!(validate(&s).is_err());
        s = start(&[]);
        s.tools = vec![ToolSpec { name: "check".into(), description: String::new(), input_schema: json!({}) }; 2];
        assert!(validate(&s).unwrap_err().contains("once each"));
    }

    #[test]
    fn lays_out_the_workspace_and_finds_what_changed() {
        let dir = tempfile::tempdir().unwrap();
        let s = start(&[("view.tsx", "a"), ("CLAUDE.md", "contract"), ("data/x.yml", "x")]);
        let keep = validate(&s).unwrap();
        assert!(prepare(dir.path(), &s, &keep).unwrap().contains(&"view.tsx".to_owned()));
        std::fs::write(dir.path().join("scratch.txt"), "gone next turn").unwrap();
        let after = collect(dir.path(), &keep);
        assert_eq!(after.keys().collect::<Vec<_>>(), ["data/x.yml", "view.tsx"]);
        std::fs::write(dir.path().join(".bridge/last.json"), serde_json::to_vec(&after).unwrap()).unwrap();
        // the same draft again: nothing changed outside; a new one: that file did
        assert!(prepare(dir.path(), &s, &keep).unwrap().is_empty());
        assert!(!dir.path().join("scratch.txt").exists());
        let s2 = start(&[("view.tsx", "b"), ("data/x.yml", "x")]);
        assert_eq!(prepare(dir.path(), &s2, &keep).unwrap(), ["view.tsx"]);
        assert!(!dir.path().join("CLAUDE.md").exists());
    }

    #[test]
    fn reads_the_stream() {
        let ws = Path::new("/w");
        let (mut session, mut failed) = (None, None);
        let e = json!({"type": "system", "subtype": "init", "session_id": "s1"});
        assert!(events_of(&e, ws, &mut session, &mut failed).is_empty());
        assert_eq!(session.as_deref(), Some("s1"));
        let e = json!({"type": "assistant", "message": {"content": [
            {"type": "text", "text": "ok"},
            {"type": "tool_use", "name": "Edit", "input": {"file_path": "/w/view.tsx"}},
            {"type": "tool_use", "name": "mcp__gestalts__check", "input": {}}]}});
        let ev = serde_json::to_value(events_of(&e, ws, &mut session, &mut failed)).unwrap();
        assert_eq!(ev, json!([{"type": "text", "text": "ok"}, {"type": "tool", "name": "Edit", "summary": "view.tsx"},
                              {"type": "tool", "name": "check", "summary": ""}]));
        let e = json!({"type": "result", "session_id": "s2", "is_error": true, "result": "budget",
                       "permission_denials": [{"tool_name": "Bash", "tool_input": {"command": "rm -rf /"}}]});
        let ev = serde_json::to_value(events_of(&e, ws, &mut session, &mut failed)).unwrap();
        assert_eq!(ev, json!([{"type": "tool", "name": "Bash", "summary": "(not allowed here) rm -rf /"}]));
        assert_eq!((session.as_deref(), failed.as_deref()), (Some("s2"), Some("budget")));
    }

    #[test]
    fn tells_claude_the_tools() {
        let mut s = start(&[]);
        s.tools = vec![ToolSpec { name: "check".into(), description: String::new(), input_schema: json!({"type": "object"}) }];
        s.session = Some("s".into());
        let a = args(&s, Path::new("/m.json"));
        assert!(a.windows(2).any(|w| w == ["--resume", "s"]));
        assert!(a.ends_with(&["mcp__gestalts__check".to_owned()]));
        assert!(!a.iter().any(|x| x.starts_with("Bash")));
    }

    #[test]
    fn dates() {
        assert_eq!(now().len(), 20);
        assert!(now().starts_with("20"));
    }
}
