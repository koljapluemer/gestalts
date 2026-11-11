//! `/llm`: completions for views, from the user's providers in the order they chose. Keys live here, in the node's
//! config folder, and never go back out. A provider that is rate-limited or out of quota is skipped for a while; one
//! that fails otherwise is skipped for this request only. Settings say how each one fared last.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::sync::Semaphore;

use crate::paths::write_atomic;

const HTTP_TIMEOUT: Duration = Duration::from_secs(90);
const CLI_TIMEOUT: Duration = Duration::from_secs(180);
const CLI_AT_ONCE: usize = 2;
const RATE_LIMIT_PAUSE: Duration = Duration::from_secs(60);
const QUOTA_PAUSE: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderId { Gemini, ClaudeCli, Openai }

impl ProviderId {
    pub const ALL: [ProviderId; 3] = [ProviderId::Gemini, ProviderId::ClaudeCli, ProviderId::Openai];
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct KeyedProvider {
    pub key: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CliProvider {
    pub enabled: bool,
    pub model: Option<String>,
}

/// `llm.json` in the config folder.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub order: Vec<ProviderId>,
    pub gemini: KeyedProvider,
    pub openai: KeyedProvider,
    pub claude_cli: CliProvider,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { order: ProviderId::ALL.to_vec(), gemini: KeyedProvider::default(), openai: KeyedProvider::default(), claude_cli: CliProvider::default() }
    }
}

pub const DEFAULT_GEMINI_MODEL: &str = "gemini-2.5-flash";
pub const DEFAULT_OPENAI_MODEL: &str = "gpt-4.1";

impl Settings {
    fn configured(&self, p: ProviderId) -> bool {
        match p {
            ProviderId::Gemini => self.gemini.key.is_some(),
            ProviderId::Openai => self.openai.key.is_some(),
            ProviderId::ClaudeCli => self.claude_cli.enabled,
        }
    }

    fn model(&self, p: ProviderId) -> String {
        match p {
            ProviderId::Gemini => self.gemini.model.clone().unwrap_or_else(|| DEFAULT_GEMINI_MODEL.into()),
            ProviderId::Openai => self.openai.model.clone().unwrap_or_else(|| DEFAULT_OPENAI_MODEL.into()),
            ProviderId::ClaudeCli => self.claude_cli.model.clone().unwrap_or_else(|| "default".into()),
        }
    }

    /// Every provider once: the chosen order first, then any it leaves out.
    fn full_order(&self) -> Vec<ProviderId> {
        let mut order: Vec<ProviderId> = Vec::new();
        for p in self.order.iter().chain(ProviderId::ALL.iter()) {
            if !order.contains(p) { order.push(*p); }
        }
        order
    }
}

/// What a settings change says: `None` keeps a value, `Some(None)` clears a key.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct SettingsChange {
    pub order: Option<Vec<ProviderId>>,
    pub gemini: Option<KeyedChange>,
    pub openai: Option<KeyedChange>,
    pub claude_cli: Option<CliChange>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct KeyedChange {
    #[serde(deserialize_with = "some_option")]
    pub key: Option<Option<String>>,
    #[serde(deserialize_with = "some_option")]
    pub model: Option<Option<String>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct CliChange {
    pub enabled: Option<bool>,
    #[serde(deserialize_with = "some_option")]
    pub model: Option<Option<String>>,
}

/// A present `null` is `Some(None)`, an absent field `None` (with `#[serde(default)]`).
fn some_option<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Ok(Some(Option::<String>::deserialize(d)?.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())))
}

fn apply_keyed(p: &mut KeyedProvider, c: KeyedChange) {
    if let Some(key) = c.key { p.key = key; }
    if let Some(model) = c.model { p.model = model; }
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderView {
    pub id: ProviderId,
    pub configured: bool,
    pub model: String,
    /// why it can't answer right now, if it can't
    pub paused: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SettingsView {
    pub order: Vec<ProviderId>,
    pub providers: Vec<ProviderView>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Completion {
    pub text: String,
    pub provider: ProviderId,
    pub model: String,
}

/// How one provider's attempt went.
#[derive(Debug, Clone, PartialEq)]
pub enum Failure {
    /// try again in a while; skipped until then
    Paused(String, Duration),
    /// skipped for this request
    Failed(String),
}

#[derive(Debug, Clone, Default)]
struct ProviderState {
    paused_until: Option<Instant>,
    last_error: Option<String>,
}

/// Tries each configured provider in order until one answers. Pure apart from `call`, so it's tested with fakes.
pub async fn run_chain<F, Fut>(order: &[ProviderId], configured: impl Fn(ProviderId) -> bool, paused: impl Fn(ProviderId) -> Option<String>,
                               mut call: F) -> Result<(ProviderId, String), Vec<(ProviderId, String)>>
where F: FnMut(ProviderId) -> Fut, Fut: Future<Output = Result<String, Failure>> {
    let mut reasons = Vec::new();
    for &p in order {
        if !configured(p) { reasons.push((p, "not set up".to_owned())); continue; }
        if let Some(why) = paused(p) { reasons.push((p, why)); continue; }
        match call(p).await {
            Ok(text) => return Ok((p, text)),
            Err(Failure::Paused(why, _) | Failure::Failed(why)) => reasons.push((p, why)),
        }
    }
    Err(reasons)
}

pub struct Llm {
    file: PathBuf,
    settings: RwLock<Settings>,
    states: Mutex<BTreeMap<ProviderId, ProviderState>>,
    cli: Arc<Semaphore>,
    client: reqwest::Client,
}

impl Llm {
    pub fn load(config_dir: &Path) -> Self {
        let file = config_dir.join("llm.json");
        let settings = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let client = reqwest::Client::builder().timeout(HTTP_TIMEOUT).build().expect("the HTTP client builds");
        Llm { file, settings: RwLock::new(settings), states: Mutex::default(), cli: Arc::new(Semaphore::new(CLI_AT_ONCE)), client }
    }

    pub fn view(&self) -> SettingsView {
        let s = self.settings.read().expect("llm settings lock").clone();
        let states = self.states.lock().expect("llm states lock");
        let now = Instant::now();
        let providers = s.full_order().into_iter().map(|id| {
            let st = states.get(&id).cloned().unwrap_or_default();
            let paused = st.paused_until.filter(|t| *t > now).map(|t| format!("paused for {} more s", (t - now).as_secs()));
            ProviderView { id, configured: s.configured(id), model: s.model(id), paused, last_error: st.last_error }
        }).collect();
        SettingsView { order: s.full_order(), providers }
    }

    pub fn change(&self, c: SettingsChange) -> std::io::Result<SettingsView> {
        {
            let mut s = self.settings.write().expect("llm settings lock");
            if let Some(order) = c.order { s.order = order; }
            if let Some(g) = c.gemini { apply_keyed(&mut s.gemini, g); }
            if let Some(o) = c.openai { apply_keyed(&mut s.openai, o); }
            if let Some(cli) = c.claude_cli {
                if let Some(e) = cli.enabled { s.claude_cli.enabled = e; }
                if let Some(m) = cli.model { s.claude_cli.model = m; }
            }
            write_secret(&self.file, &serde_json::to_vec_pretty(&*s).expect("settings serialize"))?;
        }
        // new keys or models deserve a fresh try
        self.states.lock().expect("llm states lock").clear();
        Ok(self.view())
    }

    fn paused(&self, p: ProviderId) -> Option<String> {
        let states = self.states.lock().expect("llm states lock");
        let until = states.get(&p)?.paused_until?;
        let now = Instant::now();
        (until > now).then(|| format!("paused for {} more s after a rate limit", (until - now).as_secs()))
    }

    fn record(&self, p: ProviderId, outcome: Result<(), &Failure>) {
        let mut states = self.states.lock().expect("llm states lock");
        let st = states.entry(p).or_default();
        match outcome {
            Ok(()) => { st.last_error = None; st.paused_until = None; }
            Err(Failure::Paused(why, pause)) => { st.last_error = Some(why.clone()); st.paused_until = Some(Instant::now() + *pause); }
            Err(Failure::Failed(why)) => { st.last_error = Some(why.clone()); }
        }
    }

    /// One completion from the first provider that gives one; with `json`, the answer parses as JSON.
    pub async fn complete(&self, prompt: &str, json: bool) -> Result<Completion, Vec<(ProviderId, String)>> {
        let s = self.settings.read().expect("llm settings lock").clone();
        let order = s.full_order();
        let result = run_chain(&order, |p| s.configured(p), |p| self.paused(p), |p| {
            let s = s.clone();
            async move {
                let r = self.call(&s, p, prompt, json).await.and_then(|text| if json { json_text(&text) } else { Ok(text) });
                self.record(p, r.as_ref().map(|_| ()));
                r
            }
        }).await?;
        Ok(Completion { text: result.1, provider: result.0, model: s.model(result.0) })
    }

    async fn call(&self, s: &Settings, p: ProviderId, prompt: &str, json: bool) -> Result<String, Failure> {
        match p {
            ProviderId::Gemini => gemini(&self.client, s.gemini.key.as_deref().unwrap_or_default(), &s.model(p), prompt, json).await,
            ProviderId::Openai => openai(&self.client, s.openai.key.as_deref().unwrap_or_default(), &s.model(p), prompt, json).await,
            ProviderId::ClaudeCli => {
                let _slot = self.cli.acquire().await.map_err(|e| Failure::Failed(e.to_string()))?;
                claude_cli(s.claude_cli.model.as_deref(), prompt, json).await
            }
        }
    }
}

/// Like `write_atomic`, readable by this user only.
fn write_secret(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    write_atomic(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// The JSON in an answer, without a Markdown fence around it.
pub fn json_text(text: &str) -> Result<String, Failure> {
    let t = text.trim();
    let t = t.strip_prefix("```json").or_else(|| t.strip_prefix("```")).map_or(t, |r| r.trim_end().strip_suffix("```").unwrap_or(r)).trim();
    serde_json::from_str::<Value>(t).map(|_| t.to_owned()).map_err(|_| Failure::Failed("the answer wasn't JSON".into()))
}

const JSON_INSTRUCTION: &str = "Return ONLY valid JSON. No markdown, prose, or commentary.";

/// What an HTTP provider's error status means for trying it again.
fn http_failure(name: &str, status: u16, body: &str) -> Failure {
    let quota = body.contains("insufficient_quota") || (body.contains("RESOURCE_EXHAUSTED") && body.to_lowercase().contains("quota"));
    match status {
        429 if quota => Failure::Paused(format!("{name}: out of quota"), QUOTA_PAUSE),
        429 => Failure::Paused(format!("{name}: rate-limited"), RATE_LIMIT_PAUSE),
        401 | 403 => Failure::Failed(format!("{name} rejected the key")),
        400 if body.contains("API_KEY_INVALID") => Failure::Failed(format!("{name} rejected the key")),
        _ => Failure::Failed(format!("{name} answered {status}")),
    }
}

fn request_failure(name: &str, e: &reqwest::Error) -> Failure {
    if e.is_timeout() { Failure::Failed(format!("{name} didn't answer in time")) } else { Failure::Failed(format!("{name}: {e}")) }
}

async fn gemini(client: &reqwest::Client, key: &str, model: &str, prompt: &str, json: bool) -> Result<String, Failure> {
    let url = format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent");
    let mut body = json!({ "contents": [{ "role": "user", "parts": [{ "text": prompt }] }] });
    if json { body["generationConfig"] = json!({ "responseMimeType": "application/json" }); }
    let r = client.post(url).header("x-goog-api-key", key).json(&body).send().await.map_err(|e| request_failure("Gemini", &e))?;
    let status = r.status().as_u16();
    let text = r.text().await.map_err(|e| request_failure("Gemini", &e))?;
    if status != 200 { return Err(http_failure("Gemini", status, &text)); }
    let v: Value = serde_json::from_str(&text).map_err(|_| Failure::Failed("Gemini's answer wasn't JSON".into()))?;
    let parts = v.pointer("/candidates/0/content/parts").and_then(Value::as_array).ok_or_else(|| Failure::Failed("Gemini gave no answer".into()))?;
    Ok(parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect())
}

async fn openai(client: &reqwest::Client, key: &str, model: &str, prompt: &str, json: bool) -> Result<String, Failure> {
    let mut messages = vec![json!({ "role": "user", "content": prompt })];
    let mut body = json!({ "model": model, "temperature": 0 });
    if json {
        messages.insert(0, json!({ "role": "system", "content": JSON_INSTRUCTION }));
        body["response_format"] = json!({ "type": "json_object" });
    }
    body["messages"] = Value::Array(messages);
    let r = client.post("https://api.openai.com/v1/chat/completions").bearer_auth(key).json(&body).send().await.map_err(|e| request_failure("OpenAI", &e))?;
    let status = r.status().as_u16();
    let text = r.text().await.map_err(|e| request_failure("OpenAI", &e))?;
    if status != 200 { return Err(http_failure("OpenAI", status, &text)); }
    let v: Value = serde_json::from_str(&text).map_err(|_| Failure::Failed("OpenAI's answer wasn't JSON".into()))?;
    v.pointer("/choices/0/message/content").and_then(Value::as_str).map(str::to_owned).ok_or_else(|| Failure::Failed("OpenAI gave no answer".into()))
}

/// `claude -p` with the prompt on stdin, in an empty folder, so it has nothing to look at or change.
async fn claude_cli(model: Option<&str>, prompt: &str, json: bool) -> Result<String, Failure> {
    let program = std::env::var("GESTALTS_CLAUDE").unwrap_or_else(|_| "claude".into());
    let dir = std::env::temp_dir().join("gestalts-llm");
    std::fs::create_dir_all(&dir).map_err(|e| Failure::Failed(format!("claude CLI: {e}")))?;
    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(["-p", "--output-format", "json"]).current_dir(&dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    if let Some(m) = model { cmd.args(["--model", m]); }
    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => Failure::Failed(format!("{program} isn't installed (not on PATH)")),
        _ => Failure::Failed(format!("claude CLI: {e}")),
    })?;
    let input = if json { format!("{prompt}\n\n{JSON_INSTRUCTION}") } else { prompt.to_owned() };
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input.as_bytes()).await.map_err(|e| Failure::Failed(format!("claude CLI: {e}")))?;
    }
    let out = tokio::time::timeout(CLI_TIMEOUT, child.wait_with_output()).await
        .map_err(|_| Failure::Failed(format!("claude CLI didn't answer within {}s", CLI_TIMEOUT.as_secs())))?
        .map_err(|e| Failure::Failed(format!("claude CLI: {e}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let v: Option<Value> = serde_json::from_str(stdout.trim()).ok();
    match v {
        Some(v) if v.get("is_error").and_then(Value::as_bool) != Some(true) => {
            v.get("result").and_then(Value::as_str).map(str::to_owned).ok_or_else(|| Failure::Failed("claude CLI gave no result".into()))
        }
        Some(v) => {
            let why = v.get("result").and_then(Value::as_str).unwrap_or("it reported an error").to_owned();
            // a subscription's usage limit is the CLI's rate limit
            if why.to_lowercase().contains("limit") { Err(Failure::Paused(format!("claude CLI: {why}"), RATE_LIMIT_PAUSE)) } else { Err(Failure::Failed(format!("claude CLI: {why}"))) }
        }
        None => {
            let err = String::from_utf8_lossy(&out.stderr);
            let line = err.lines().find(|l| !l.trim().is_empty()).unwrap_or("no output");
            Err(Failure::Failed(format!("claude CLI failed: {line}")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[tokio::test]
    async fn falls_through_to_the_first_provider_that_answers() {
        let tried = RefCell::new(Vec::new());
        let r = run_chain(&ProviderId::ALL, |p| p != ProviderId::ClaudeCli, |_| None, |p| {
            tried.borrow_mut().push(p);
            async move {
                match p {
                    ProviderId::Gemini => Err(Failure::Paused("rate-limited".into(), RATE_LIMIT_PAUSE)),
                    _ => Ok("{}".to_owned()),
                }
            }
        }).await;
        assert_eq!(r, Ok((ProviderId::Openai, "{}".to_owned())));
        assert_eq!(*tried.borrow(), vec![ProviderId::Gemini, ProviderId::Openai]);
    }

    #[tokio::test]
    async fn skips_paused_providers_and_says_why_none_answered() {
        let r = run_chain(&[ProviderId::Gemini, ProviderId::Openai], |_| true, |p| (p == ProviderId::Gemini).then(|| "paused".to_owned()),
                          |_| async { Err::<String, _>(Failure::Failed("bad key".into())) }).await;
        assert_eq!(r, Err(vec![(ProviderId::Gemini, "paused".into()), (ProviderId::Openai, "bad key".into())]));
    }

    #[test]
    fn rate_limits_pause_and_quota_pauses_longer() {
        assert_eq!(http_failure("X", 429, ""), Failure::Paused("X: rate-limited".into(), RATE_LIMIT_PAUSE));
        assert_eq!(http_failure("X", 429, r#"{"error":{"code":"insufficient_quota"}}"#), Failure::Paused("X: out of quota".into(), QUOTA_PAUSE));
        assert_eq!(http_failure("X", 401, ""), Failure::Failed("X rejected the key".into()));
    }

    #[test]
    fn json_answers_may_come_fenced() {
        assert_eq!(json_text("```json\n{\"a\":1}\n```").unwrap(), "{\"a\":1}");
        assert!(json_text("sure! {").is_err());
    }

    #[test]
    fn keys_are_kept_set_or_cleared_and_never_shown() {
        let dir = std::env::temp_dir().join(format!("gestalts-llm-test-{}", uuid::Uuid::new_v4()));
        let llm = Llm::load(&dir);
        let change: SettingsChange = serde_json::from_str(r#"{"gemini":{"key":"secret"},"order":["openai"]}"#).unwrap();
        let view = llm.change(change).unwrap();
        assert!(view.providers.iter().any(|p| p.id == ProviderId::Gemini && p.configured));
        assert_eq!(view.order, vec![ProviderId::Openai, ProviderId::Gemini, ProviderId::ClaudeCli]);
        assert!(!serde_json::to_string(&view).unwrap().contains("secret"));
        llm.change(serde_json::from_str(r#"{"gemini":{"model":"m"}}"#).unwrap()).unwrap();
        assert_eq!(Llm::load(&dir).settings.read().unwrap().gemini.key.as_deref(), Some("secret"));
        llm.change(serde_json::from_str(r#"{"gemini":{"key":null}}"#).unwrap()).unwrap();
        assert!(Llm::load(&dir).settings.read().unwrap().gemini.key.is_none());
        std::fs::remove_dir_all(dir).ok();
    }
}
