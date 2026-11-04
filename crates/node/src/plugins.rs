use std::collections::{BTreeMap, BTreeSet};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use gestalts_core::{Gestalts, Note};
use gestalts_plugin_host::{PluginBundle, Runtime, Trigger, WorkerManifest};
use serde::{Deserialize, Serialize};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, RwLock};

use crate::paths::Paths;
use crate::uv::{self, UvState};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginView {
    pub id: String,
    pub version: String,
    pub state: PluginState,
    pub services: Vec<String>,
    pub error: Option<String>,
    pub current_run: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginState { Stopped, Starting, Ready, Running, Error }

pub struct HostedPlugin {
    pub bundle: PluginBundle,
    pub worker: WorkerManifest,
    pub view: PluginView,
    pub token: String,
    pub worker_url: Option<String>,
    child: Option<Child>,
}

#[derive(Clone)]
pub struct PluginHost {
    inner: Arc<RwLock<BTreeMap<String, Arc<Mutex<HostedPlugin>>>>>,
    connector_url: String,
    paths: Paths,
    uv: Arc<std::sync::RwLock<UvState>>,
    client: reqwest::Client,
    /// the core's gestalts and every plugin's
    gestalts: Arc<Gestalts>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunRequest<'a> { run_id: &'a str, trigger: TriggerRequest, note_keys: Vec<String> }

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum TriggerRequest { Manual, Change }

#[derive(Debug, Deserialize)]
struct Health { protocol: u32 }

impl PluginHost {
    pub fn discover(dirs: &[PathBuf], connector_url: String, paths: Paths) -> Result<Self, String> {
        let mut found = BTreeMap::new();
        let mut services = BTreeSet::new();
        let mut bundles: Vec<PluginBundle> = Vec::new();
        for dir in dirs {
            if !dir.exists() { continue; }
            let entries = std::fs::read_dir(dir).map_err(|e| format!("cannot read plugin directory {}: {e}", dir.display()))?;
            for entry in entries.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())) {
                if !entry.path().join("plugin.yml").is_file() { continue; }
                let bundle = PluginBundle::load(entry.path()).map_err(|e| format!("{}: {e}", entry.path().display()))?;
                if bundles.iter().any(|b| b.manifest.id == bundle.manifest.id) { return Err(format!("duplicate plugin {}", bundle.manifest.id)); }
                bundles.push(bundle.clone());
                // only plugins with a worker run here; the others are UI and data, for the apps
                let Some(worker) = bundle.manifest.worker.clone() else { continue };
                for service in &worker.services {
                    if !services.insert(service.clone()) { return Err(format!("duplicate service {service}")); }
                }
                let id = bundle.manifest.id.clone();
                let view = PluginView { id: id.clone(), version: bundle.manifest.version.clone(), state: PluginState::Stopped,
                    services: worker.services.clone(), error: None, current_run: None };
                found.insert(id, Arc::new(Mutex::new(HostedPlugin { bundle, worker, view, token: uuid::Uuid::new_v4().to_string(), worker_url: None, child: None })));
            }
        }
        let gestalts = gestalts_plugin_host::gestalts_with(&bundles.iter().collect::<Vec<_>>())?;
        Ok(Self { inner: Arc::new(RwLock::new(found)), connector_url, paths, uv: Arc::new(std::sync::RwLock::new(UvState::Locating)), client: reqwest::Client::new(), gestalts: Arc::new(gestalts) })
    }

    /// The core's gestalts and those of every plugin found, for lints, triggers, access checks and merging.
    pub fn gestalts(&self) -> &Gestalts { &self.gestalts }

    pub fn uv_state(&self) -> UvState { self.uv.read().expect("uv state lock").clone() }

    fn set_uv(&self, state: UvState) { *self.uv.write().expect("uv state lock") = state; }

    /// Finds (or downloads) uv, then starts every plugin's worker.
    pub async fn start_all(&self) {
        let plugins: Vec<_> = self.inner.read().await.values().cloned().collect();
        if plugins.is_empty() { return; }
        let uv = match uv::locate(&self.paths.data, || self.set_uv(UvState::Downloading)).await {
            Ok((path, version)) => { self.set_uv(UvState::Ready { path: path.clone(), version }); path }
            Err(error) => {
                self.set_uv(UvState::Failed { error: error.clone() });
                for plugin in plugins {
                    let mut p = plugin.lock().await;
                    p.view.state = PluginState::Error;
                    p.view.error = Some(format!("uv unavailable: {error}"));
                }
                return;
            }
        };
        for plugin in plugins {
            if let Err(e) = self.start(plugin.clone(), &uv).await {
                let mut p = plugin.lock().await;
                p.view.state = PluginState::Error;
                p.view.error = Some(e);
            }
        }
    }

    /// Stops every worker (on quit; dropping the host alone doesn't, since the process may exit first).
    pub async fn stop_all(&self) {
        let plugins: Vec<_> = self.inner.read().await.values().cloned().collect();
        for plugin in plugins {
            let mut p = plugin.lock().await;
            if let Some(mut child) = p.child.take() { let _ = child.kill().await; }
            p.view.state = PluginState::Stopped;
        }
    }

    async fn start(&self, plugin: Arc<Mutex<HostedPlugin>>, uv: &std::path::Path) -> Result<(), String> {
        let mut p = plugin.lock().await;
        p.view.state = PluginState::Starting;
        if p.worker.runtime != Runtime::Uv { return Err("unsupported runtime".into()); }
        let project = p.bundle.root.join(&p.worker.project);
        let environment = self.paths.cache.join("plugins").join(&p.bundle.manifest.id).join("venv");
        std::fs::create_dir_all(environment.parent().unwrap()).map_err(|e| e.to_string())?;
        let sync = self.uv_command(uv).args(["sync", "--locked", "--project"]).arg(&project)
            .env("UV_PROJECT_ENVIRONMENT", &environment).stdout(Stdio::null()).stderr(Stdio::piped()).output().await.map_err(|e| format!("cannot run uv: {e}"))?;
        if !sync.status.success() { return Err(format!("uv sync failed: {}", String::from_utf8_lossy(&sync.stderr).trim())); }
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        drop(listener);
        // run the synced environment's executables directly (not via `uv run`), so the process we
        // stop is the worker itself rather than a uv parent whose child would outlive it
        let command = &p.worker.command;
        let bin = environment.join(if cfg!(windows) { "Scripts" } else { "bin" });
        let program = [bin.join(&command[0]), bin.join(format!("{}.exe", command[0]))].into_iter().find(|p| p.is_file())
            .unwrap_or_else(|| PathBuf::from(&command[0]));
        let path = std::env::join_paths(std::iter::once(bin.clone()).chain(std::env::var_os("PATH").iter().flat_map(std::env::split_paths)))
            .map_err(|e| e.to_string())?;
        let mut cmd = Command::new(program);
        cmd.args(&command[1..])
            .current_dir(&project)
            .env("VIRTUAL_ENV", &environment).env("PATH", path).stdin(Stdio::null())
            .env("GESTALTS_CONNECTOR_URL", &self.connector_url).env("GESTALTS_PLUGIN_TOKEN", &p.token)
            .env("GESTALTS_PLUGIN_ID", &p.bundle.manifest.id).env("GESTALTS_WORKER_PORT", port.to_string())
            .stdout(Stdio::inherit()).stderr(Stdio::inherit()).kill_on_drop(true);
        p.child = Some(cmd.spawn().map_err(|e| format!("cannot start worker: {e}"))?);
        let url = format!("http://127.0.0.1:{port}");
        p.worker_url = Some(url.clone());
        drop(p);
        for _ in 0..50 {
            if let Ok(response) = self.client.get(format!("{url}/_gestalts/health")).send().await
                && let Ok(health) = response.json::<Health>().await && health.protocol == 1 {
                let mut p = plugin.lock().await; p.view.state = PluginState::Ready; p.view.error = None; return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Err("worker readiness timed out".into())
    }

    /// uv with its Python installs and download cache kept inside the app's own folders.
    fn uv_command(&self, uv: &std::path::Path) -> Command {
        let mut cmd = Command::new(uv);
        cmd.env("UV_PYTHON_INSTALL_DIR", self.paths.data.join("python")).env("UV_CACHE_DIR", self.paths.cache.join("uv"))
            .stdin(Stdio::null());
        cmd
    }

    pub async fn views(&self) -> Vec<PluginView> {
        let plugins: Vec<_> = self.inner.read().await.values().cloned().collect();
        let mut out = Vec::new();
        for p in plugins { out.push(p.lock().await.view.clone()); }
        out
    }

    pub async fn run(&self, id: &str) -> Result<String, String> {
        self.run_with(id, TriggerRequest::Manual, vec![]).await
    }

    async fn run_with(&self, id: &str, trigger: TriggerRequest, note_keys: Vec<String>) -> Result<String, String> {
        let plugin = self.inner.read().await.get(id).cloned().ok_or_else(|| "unknown plugin".to_string())?;
        self.revive(&plugin).await;
        let (url, run_id) = {
            let mut p = plugin.lock().await;
            if p.view.state != PluginState::Ready { return Err("plugin is not ready".into()); }
            let run_id = uuid::Uuid::new_v4().to_string();
            p.view.state = PluginState::Running; p.view.current_run = Some(run_id.clone());
            (p.worker_url.clone().unwrap(), run_id)
        };
        let host = self.clone(); let id = id.to_owned(); let returned = run_id.clone();
        tokio::spawn(async move {
            let result = host.client.post(format!("{url}/_gestalts/runs"))
                .json(&RunRequest { run_id: &run_id, trigger, note_keys }).send().await;
            if let Some(plugin) = host.inner.read().await.get(&id).cloned() {
                let mut p = plugin.lock().await; p.view.current_run = None;
                match result { Ok(r) if r.status().is_success() => p.view.state = PluginState::Ready,
                    Ok(r) => { p.view.state = PluginState::Error; p.view.error = Some(format!("run returned {}", r.status())); },
                    Err(e) => { p.view.state = PluginState::Error; p.view.error = Some(e.to_string()); } }
            }
        });
        Ok(returned)
    }

    pub async fn note_changed(&self, key: &str, text: &str) {
        let note = Note::parse(key, text);
        let gestalts = self.gestalts.of(&note);
        let plugins: Vec<_> = self.inner.read().await.values().cloned().collect();
        for plugin in plugins {
            let id = {
                let p = plugin.lock().await;
                let matched = p.worker.triggers.iter().any(|t| match t {
                    Trigger::Change { query } => query.matches(&note, &gestalts),
                    Trigger::Schedule { .. } => false,
                });
                matched.then(|| p.bundle.manifest.id.clone())
            };
            if let Some(id) = id { let _ = self.run_with(&id, TriggerRequest::Change, vec![key.to_owned()]).await; }
        }
    }

    pub async fn services(&self) -> Vec<(String, bool)> {
        let plugins: Vec<_> = self.inner.read().await.values().cloned().collect(); let mut out = vec![];
        for p in plugins { let p = p.lock().await; for s in &p.view.services { out.push((s.clone(), matches!(p.view.state, PluginState::Ready | PluginState::Running))); } }
        out
    }

    /// The worker serving `service`, restarted first if its process has ended.
    pub async fn service_url(&self, service: &str) -> Option<String> {
        let plugins: Vec<_> = self.inner.read().await.values().cloned().collect();
        for plugin in plugins {
            if !plugin.lock().await.view.services.iter().any(|s| s == service) { continue; }
            self.revive(&plugin).await;
            let p = plugin.lock().await;
            return matches!(p.view.state, PluginState::Ready | PluginState::Running).then(|| p.worker_url.clone()).flatten();
        }
        None
    }

    /// The HTTP client for talking to workers.
    pub fn client(&self) -> &reqwest::Client { &self.client }

    /// Restarts a worker whose process has ended (crashed, killed), so one failure doesn't leave its runs and
    /// services dead until the connector restarts. Its view says what happened meanwhile.
    async fn revive(&self, plugin: &Arc<Mutex<HostedPlugin>>) {
        {
            let mut p = plugin.lock().await;
            let Some(Ok(Some(status))) = p.child.as_mut().map(Child::try_wait) else { return };
            p.child = None;
            p.view.state = PluginState::Error;
            p.view.error = Some(format!("worker exited ({status}); restarting"));
        }
        let UvState::Ready { path, .. } = self.uv_state() else { return };
        if let Err(e) = self.start(plugin.clone(), &path).await {
            let mut p = plugin.lock().await;
            p.view.state = PluginState::Error;
            p.view.error = Some(e);
        }
    }

    pub async fn policy_for_token(&self, token: &str) -> Option<gestalts_plugin_host::Access> {
        let plugins: Vec<_> = self.inner.read().await.values().cloned().collect();
        for p in plugins { let p = p.lock().await; if p.token == token { return Some(p.worker.access.clone()); } }
        None
    }
}

/// The core's gestalts plus those of the plugins in `dirs` (without hosting them).
pub fn load_gestalts(dirs: &[PathBuf]) -> Result<Gestalts, String> {
    let mut bundles = Vec::new();
    for dir in dirs.iter().filter(|d| d.exists()) {
        let entries = std::fs::read_dir(dir).map_err(|e| format!("cannot read plugin directory {}: {e}", dir.display()))?;
        for entry in entries.flatten().filter(|e| e.path().join("plugin.yml").is_file()) {
            bundles.push(PluginBundle::load(entry.path()).map_err(|e| format!("{}: {e}", entry.path().display()))?);
        }
    }
    gestalts_plugin_host::gestalts_with(&bundles.iter().collect::<Vec<_>>())
}

pub fn unpack_builtin(paths: &Paths, builtin: &include_dir::Dir<'_>, sdk: &include_dir::Dir<'_>) -> std::io::Result<PathBuf> {
    use sha2::{Digest, Sha256};
    let mut files = Vec::new();
    collect(builtin, Path::new("plugins"), &mut files);
    collect(sdk, Path::new("sdk/python"), &mut files);
    let mut hash = Sha256::new();
    for (path, f) in &files { hash.update(path.to_string_lossy().as_bytes()); hash.update([0]); hash.update(f.contents()); }
    let id: String = hash.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect();
    let root = paths.data.join("builtin-plugins");
    let dest = root.join(&id);
    if !dest.is_dir() {
        let tmp = root.join(format!("{id}.part"));
        let _ = std::fs::remove_dir_all(&tmp);
        for (path, f) in &files {
            let path = tmp.join(path);
            std::fs::create_dir_all(path.parent().expect("file is in a folder"))?;
            std::fs::write(path, f.contents())?;
        }
        std::fs::rename(&tmp, &dest)?;
    }
    // older builds' copies
    for entry in std::fs::read_dir(&root)?.flatten() {
        if entry.file_name() != id.as_str() { let _ = std::fs::remove_dir_all(entry.path()); }
    }
    Ok(dest.join("plugins"))
}

/// Files under `dir`, with their paths below `prefix`; skips Python caches and environments.
fn collect<'a>(dir: &'a include_dir::Dir<'a>, prefix: &Path, out: &mut Vec<(PathBuf, &'a include_dir::File<'a>)>) {
    for entry in dir.entries() {
        match entry {
            include_dir::DirEntry::Dir(d) if d.path().file_name().is_some_and(|n| n == "__pycache__" || n == ".venv") => {}
            include_dir::DirEntry::Dir(d) => collect(d, prefix, out),
            include_dir::DirEntry::File(f) => out.push((prefix.join(f.path()), f)),
        }
    }
}
