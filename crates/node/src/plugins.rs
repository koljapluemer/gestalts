use std::collections::{BTreeMap, BTreeSet};
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use gestalts_core::Gestalts;
use serde::{Deserialize, Serialize};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, RwLock};

use crate::manifest::{AccessPolicy, PluginBundle};
use crate::paths::Paths;
use crate::uv::{self, UvState};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginView {
    pub id: String,
    pub version: String,
    pub state: PluginState,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginState { Stopped, Starting, Ready, Error }

pub struct HostedPlugin {
    pub bundle: PluginBundle,
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
    /// every host some plugin's view may reach through `/net`
    network: Arc<BTreeSet<String>>,
}

/// What a `backend.py` imports; written next to it at start, so a plugin needs nothing installed.
const BACKEND_SDK: &str = include_str!("../../../sdk/python/gestalts_backend.py");

#[derive(Debug, Deserialize)]
struct Health { protocol: u32 }

impl PluginHost {
    pub fn discover(dirs: &[PathBuf], connector_url: String, paths: Paths) -> Result<Self, String> {
        let mut found = BTreeMap::new();
        let mut bundles: Vec<PluginBundle> = Vec::new();
        for dir in dirs {
            if !dir.exists() { continue; }
            let entries = std::fs::read_dir(dir).map_err(|e| format!("cannot read plugin directory {}: {e}", dir.display()))?;
            for entry in entries.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())) {
                if !entry.path().join("plugin.yml").is_file() { continue; }
                let bundle = PluginBundle::load(entry.path()).map_err(|e| format!("{}: {e}", entry.path().display()))?;
                if bundles.iter().any(|b| b.manifest.id == bundle.manifest.id) { return Err(format!("duplicate plugin {}", bundle.manifest.id)); }
                bundles.push(bundle.clone());
                // only plugins with a backend run here; the others are a view and data, for the apps
                if bundle.backend().is_none() { continue; }
                let id = bundle.manifest.id.clone();
                let view = PluginView { id: id.clone(), version: bundle.manifest.version.clone(), state: PluginState::Stopped, error: None };
                found.insert(id, Arc::new(Mutex::new(HostedPlugin { bundle, view, token: uuid::Uuid::new_v4().to_string(), worker_url: None, child: None })));
            }
        }
        let gestalts = crate::manifest::gestalts_with(&bundles.iter().collect::<Vec<_>>())?;
        let network = bundles.iter().flat_map(|b| b.manifest.network.iter().cloned()).collect();
        Ok(Self { inner: Arc::new(RwLock::new(found)), connector_url, paths, uv: Arc::new(std::sync::RwLock::new(UvState::Locating)), client: reqwest::Client::new(), gestalts: Arc::new(gestalts), network: Arc::new(network) })
    }

    /// Every host some plugin found here declares in `network`.
    pub fn network_hosts(&self) -> BTreeSet<String> { (*self.network).clone() }

    /// Where this node keeps its settings.
    pub fn config_dir(&self) -> &std::path::Path { &self.paths.config }

    /// The core's gestalts and those of every plugin found, for access checks and merging.
    pub fn gestalts(&self) -> &Gestalts { &self.gestalts }

    pub fn uv_state(&self) -> UvState { self.uv.read().expect("uv state lock").clone() }

    fn set_uv(&self, state: UvState) { *self.uv.write().expect("uv state lock") = state; }

    /// Finds (or downloads) uv, then starts every plugin's backend.
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

    /// Stops every backend (on quit; dropping the host alone doesn't, since the process may exit first).
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
        // absolute: it runs from the plugin's own folder, and `--plugins-dir` may be relative
        let script = std::fs::canonicalize(p.bundle.backend().ok_or("this plugin has no backend")?).map_err(|e| e.to_string())?;
        // the script's own environment, from its inline metadata; the interpreter runs directly (not via `uv run`), so
        // the process we stop is the backend itself rather than a uv parent whose child would outlive it
        let sync = self.uv_command(uv).args(["sync", "--script"]).arg(&script).stdout(Stdio::null()).stderr(Stdio::piped()).output().await
            .map_err(|e| format!("cannot run uv: {e}"))?;
        if !sync.status.success() { return Err(format!("uv sync failed: {}", String::from_utf8_lossy(&sync.stderr).trim())); }
        let python = self.uv_command(uv).args(["python", "find", "--script"]).arg(&script).stderr(Stdio::piped()).output().await
            .map_err(|e| format!("cannot run uv: {e}"))?;
        if !python.status.success() { return Err(format!("uv python find failed: {}", String::from_utf8_lossy(&python.stderr).trim())); }
        let python = PathBuf::from(String::from_utf8_lossy(&python.stdout).trim());
        let sdk = self.paths.cache.join("backend-sdk");
        std::fs::create_dir_all(&sdk).map_err(|e| e.to_string())?;
        std::fs::write(sdk.join("gestalts_backend.py"), BACKEND_SDK).map_err(|e| e.to_string())?;
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        drop(listener);
        let mut cmd = Command::new(python);
        cmd.arg(&script)
            .current_dir(&p.bundle.root)
            .stdin(Stdio::null())
            .env("PYTHONPATH", &sdk).env("PYTHONDONTWRITEBYTECODE", "1")
            .env("GESTALTS_NODE_URL", &self.connector_url).env("GESTALTS_PLUGIN_TOKEN", &p.token)
            .env("GESTALTS_PLUGIN_ID", &p.bundle.manifest.id).env("GESTALTS_WORKER_PORT", port.to_string())
            .stdout(Stdio::inherit()).stderr(Stdio::inherit()).kill_on_drop(true);
        p.child = Some(cmd.spawn().map_err(|e| format!("cannot start the backend: {e}"))?);
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
        Err("the backend did not become ready".into())
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

    /// Each backend's plugin id, and whether it's up.
    pub async fn services(&self) -> Vec<(String, bool)> {
        let plugins: Vec<_> = self.inner.read().await.values().cloned().collect();
        let mut out = vec![];
        for p in plugins {
            let p = p.lock().await;
            out.push((p.view.id.clone(), p.view.state == PluginState::Ready));
        }
        out
    }

    /// The backend of the plugin `service`, restarted first if its process has ended.
    pub async fn service_url(&self, service: &str) -> Option<String> {
        let plugin = self.inner.read().await.get(service).cloned()?;
        self.revive(&plugin).await;
        let p = plugin.lock().await;
        (p.view.state == PluginState::Ready).then(|| p.worker_url.clone()).flatten()
    }

    /// The HTTP client for talking to workers.
    pub fn client(&self) -> &reqwest::Client { &self.client }

    /// Restarts a backend whose process has ended (crashed, killed), so one failure doesn't leave it dead until the
    /// node restarts. Its view says what happened meanwhile.
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

    pub async fn policy_for_token(&self, token: &str) -> Option<AccessPolicy> {
        let plugins: Vec<_> = self.inner.read().await.values().cloned().collect();
        for p in plugins { let p = p.lock().await; if p.token == token { return Some(AccessPolicy::of(&p.bundle.manifest)); } }
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
    crate::manifest::gestalts_with(&bundles.iter().collect::<Vec<_>>())
}

pub fn unpack_builtin(paths: &Paths, builtin: &include_dir::Dir<'_>) -> std::io::Result<PathBuf> {
    use sha2::{Digest, Sha256};
    let mut files = Vec::new();
    collect(builtin, Path::new("plugins"), &mut files);
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
