//! A device's own folder of notes, synced with the node it paired with (`doc/node.md#pairing-and-the-home-network`):
//! the native side of the Gestalter on a phone. The app's page runs the core in wasm over this folder (its storage
//! calls come in through [`Handle`]); this crate keeps the folder, the pairing and the sync, and tells the app what
//! changed ([`Event`]).
//!
//! The core isn't `Send`, so a [`Device`] lives on a thread of its own ([`spawn`]), and [`Handle`] sends it jobs.
//! Writes and a sync's merge take turns (as in the page's write queue): a merge never writes over a note the app
//! wrote while it read it. Fetching and pushing go over the network alongside the app's writes.
//!
//! In the data folder:
//! - `data/notes/<id>.yml`, `data/blobs/<name>`: the ymls, as on any device
//! - `paired.json`: the node paired with, its token included (keep the folder private)
//! - `sync-base/<base_name>/`: what the notes were at the last sync, per node and folder
//! - `gestalts.json`: the plugins' gestalt definitions, from the last time the app opened, for merging
//! - `blob-gc.json`: blobs no note references, since when

use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::future::LocalBoxFuture;
use gestalts_core::storage::{Hashes, Result, Storage, StorageError, Tracked};
use gestalts_core::{GcManifest, Gestalts, SyncBase, SyncReport};
use gestalts_fs::FsStorage;
use gestalts_peer::paired::{self, PairedNode, PairingUri};
use serde::Serialize;
use tokio::sync::{Mutex, Notify, mpsc, oneshot};

/// How long after a write the sync starts, so a burst of writes syncs once.
pub const WRITE_DELAY: Duration = Duration::from_millis(800);
/// How often the device syncs while the app is in the foreground.
pub const POLL: Duration = Duration::from_secs(15);

fn io(e: impl std::fmt::Display) -> StorageError {
    StorageError::Io(e.to_string())
}

/// The node this device is paired with, to show.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeInfo {
    pub node_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncState {
    /// not paired
    Off,
    Syncing,
    Ok,
    Error,
}

/// How syncing with the paired node goes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub paired: Option<NodeInfo>,
    pub state: SyncState,
    pub error: Option<String>,
    /// unix ms of the last sync that worked
    pub last_sync: Option<i64>,
    /// that sync's `SyncReport`
    pub last_report: Option<serde_json::Value>,
    /// the path of the folder the node serves, as of the last sync
    pub folder: Option<String>,
    /// `conflict@1` notes the syncs since the app started recorded
    pub conflicts: Vec<String>,
}

/// What the device tells the app.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// notes and blobs a sync changed in the folder (blobs: pulled, or collected)
    Changed { notes: Vec<String>, blobs: Vec<String> },
    Status(Status),
}

/// The app around the device. Called on the device's thread.
pub trait Host: Send + 'static {
    fn event(&self, event: Event);
    /// Held while the device looks for the node on the network (mDNS): Android drops multicast packets unless the
    /// app holds a `WifiManager.MulticastLock`.
    fn multicast(&self, _hold: bool) {}
}

/// A device's folder, pairing and sync. Lives on one thread; see [`spawn`].
pub struct Device {
    dir: PathBuf,
    notes: Tracked<FsStorage>,
    gestalts: RefCell<Gestalts>,
    paired: RefCell<Option<PairedNode>>,
    status: RefCell<Status>,
    /// writes and a sync's merge take turns
    writes: Mutex<()>,
    /// sync now
    now: Notify,
    /// sync in a moment (after a write)
    soon: Notify,
    /// the app is in the foreground: sync on a timer
    active: Cell<bool>,
    /// blobs were collected since the device opened
    collected: Cell<bool>,
    host: Box<dyn Host>,
}

impl Device {
    /// The device whose data is in `dir` (an app's private storage), created if new.
    pub fn open(dir: &Path, host: Box<dyn Host>) -> Result<Device> {
        std::fs::create_dir_all(dir.join("data")).map_err(io)?;
        let saved: Vec<String> = read_json(&dir.join("gestalts.json"))?.unwrap_or_default();
        // definitions an older or newer app saved that this core can't read: merge by the core's own until it opens
        let gestalts = Gestalts::builtin_with(&saved.iter().map(String::as_str).collect::<Vec<_>>()).unwrap_or_else(|_| Gestalts::builtin());
        let paired: Option<PairedNode> = read_json(&dir.join("paired.json"))?;
        let status = Status {
            paired: paired.as_ref().map(info),
            state: if paired.is_some() { SyncState::Ok } else { SyncState::Off },
            error: None,
            last_sync: None,
            last_report: None,
            folder: None,
            conflicts: vec![],
        };
        Ok(Device {
            dir: dir.to_owned(),
            notes: Tracked::new(FsStorage::new(dir.join("data"))),
            gestalts: RefCell::new(gestalts),
            paired: RefCell::new(paired),
            status: RefCell::new(status),
            writes: Mutex::new(()),
            now: Notify::new(),
            soon: Notify::new(),
            active: Cell::new(true),
            collected: Cell::new(false),
            host,
        })
    }

    /// The folder with the notes and blobs (`notes/`, `blobs/`).
    pub fn folder(&self) -> PathBuf {
        self.dir.join("data")
    }

    /// The notes, as the app's page reads and writes them.
    pub fn notes(&self) -> &dyn Storage {
        &self.notes
    }

    /// The plugins' gestalt definitions (YAML), which merging notes needs: the app passes them on each start, and they
    /// are kept for syncing without it.
    pub fn set_gestalts(&self, yaml: Vec<String>) -> Result<()> {
        let g = Gestalts::builtin_with(&yaml.iter().map(String::as_str).collect::<Vec<_>>()).map_err(io)?;
        write_json(&self.dir.join("gestalts.json"), &yaml)?;
        *self.gestalts.borrow_mut() = g;
        Ok(())
    }

    pub async fn write_yml(&self, key: &str, text: &str) -> Result<()> {
        let _w = self.writes.lock().await;
        self.notes.write_yml(key, text).await?;
        self.soon.notify_one();
        Ok(())
    }

    pub async fn write_ymls(&self, notes: &[(String, String)]) -> Result<()> {
        let _w = self.writes.lock().await;
        self.notes.write_ymls(notes).await?;
        self.soon.notify_one();
        Ok(())
    }

    pub async fn delete_yml(&self, key: &str) -> Result<()> {
        let _w = self.writes.lock().await;
        self.notes.delete_yml(key).await?;
        self.soon.notify_one();
        Ok(())
    }

    pub async fn write_blob(&self, name: &str, bytes: &[u8]) -> Result<()> {
        let _w = self.writes.lock().await;
        self.notes.write_blob(name, bytes).await?;
        self.soon.notify_one();
        Ok(())
    }

    pub async fn delete_blob(&self, name: &str) -> Result<()> {
        let _w = self.writes.lock().await;
        self.notes.delete_blob(name).await
    }

    pub fn status(&self) -> Status {
        self.status.borrow().clone()
    }

    fn set_status(&self, f: impl FnOnce(&mut Status)) {
        let status = {
            let mut s = self.status.borrow_mut();
            f(&mut s);
            s.clone()
        };
        self.host.event(Event::Status(status));
    }

    /// Whether the app is in the foreground. Becoming so syncs at once; while it is, every [`POLL`].
    pub fn set_active(&self, active: bool) {
        let was = self.active.replace(active);
        if active && !was {
            self.now.notify_one();
        }
    }

    /// Asks for a sync now (it runs after the one running, if any).
    pub fn sync_soon(&self) {
        self.now.notify_one();
    }

    /// Pairs with the node whose pairing code is `uri` (the desktop's QR code), as `device_name`, then syncs.
    pub async fn pair(&self, uri: &str, device_name: &str) -> Result<NodeInfo> {
        let uri = PairingUri::parse(uri)?;
        let node = paired::pair(&uri, device_name).await?;
        write_json(&self.dir.join("paired.json"), &node)?;
        let i = info(&node);
        *self.paired.borrow_mut() = Some(node);
        self.set_status(|s| {
            *s = Status { paired: Some(i.clone()), state: SyncState::Ok, error: None, last_sync: None, last_report: None, folder: None, conflicts: vec![] };
        });
        self.now.notify_one();
        Ok(i)
    }

    /// Forgets the paired node on this device (the node lists the device until it's removed there too). The notes
    /// stay.
    pub fn forget(&self) -> Result<()> {
        self.paired.borrow_mut().take();
        remove(&self.dir.join("paired.json"))?;
        match std::fs::remove_dir_all(self.dir.join("sync-base")) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(io(e)),
            _ => {}
        }
        self.set_status(|s| {
            *s = Status { paired: None, state: SyncState::Off, error: None, last_sync: None, last_report: None, folder: None, conflicts: vec![] };
        });
        Ok(())
    }

    /// Syncs with the paired node, if any; the status tells how it went.
    pub async fn sync(&self) -> Result<SyncReport> {
        let Some(mut node) = self.paired.borrow().clone() else { return Err(io("not paired with a computer")) };
        self.set_status(|s| s.state = SyncState::Syncing);
        let result = self.sync_node(&mut node).await;
        let still_paired = self.paired.borrow().as_ref().is_some_and(|p| p.device_id == node.device_id);
        if !still_paired {
            // forgotten meanwhile
            return result.map(|(r, _)| r);
        }
        match result {
            Ok((report, folder)) => {
                let json = serde_json::to_value(&report).ok();
                self.set_status(|s| {
                    s.state = SyncState::Ok;
                    s.error = None;
                    s.last_sync = Some(now_ms());
                    s.last_report = json;
                    s.folder = Some(folder);
                    s.conflicts.extend(report.conflicts.iter().cloned());
                });
                Ok(report)
            }
            Err(e) => {
                self.set_status(|s| {
                    s.state = SyncState::Error;
                    s.error = Some(e.to_string());
                });
                Err(e)
            }
        }
    }

    async fn sync_node(&self, node: &mut PairedNode) -> Result<(SyncReport, String)> {
        self.host.multicast(true);
        let peer = paired::connect(node).await;
        self.host.multicast(false);
        let peer = peer?;
        // the address that answered goes first next time
        let changed = self.paired.borrow().as_ref().is_some_and(|p| p.device_id == node.device_id && p.addrs != node.addrs);
        if changed {
            write_json(&self.dir.join("paired.json"), &*node)?;
            *self.paired.borrow_mut() = Some(node.clone());
        }
        let health = peer.health().await?;
        let folder = &health["folder"];
        let (Some(folder_id), Some(path)) = (folder["id"].as_str(), folder["path"].as_str()) else {
            return Err(io(format!("{} has no folder open yet: choose one in the Gestalter there", node.name)));
        };
        let base = self.dir.join("sync-base").join(paired::base_name(&node.node_id, folder_id));
        let report = self.sync_with(&peer, &base).await?;
        if changed_anything(&report) {
            // the node collects its own unreferenced blobs, with its own grace period
            let _ = peer.collect_blobs().await;
        }
        Ok((report, path.to_owned()))
    }

    /// Syncs the notes with `remote`, keeping the base in `base_dir`; tells the app what changed here.
    pub async fn sync_with(&self, remote: &dyn Storage, base_dir: &Path) -> Result<SyncReport> {
        let g = self.gestalts.borrow().clone();
        let mut base = SyncBase::open(FsStorage::new(base_dir)).await?;
        let fetched = gestalts_core::fetch_remote(&self.notes, remote, &base, &g, &mut |_| {}).await?;
        let pending = {
            let _w = self.writes.lock().await;
            gestalts_core::merge_local(&self.notes, remote, &mut base, fetched, &g, &now(), &mut |_| {}).await?
        };
        let r = pending.report();
        let notes: Vec<String> = r.pulled.iter().chain(&r.conflicts).cloned().collect();
        if !notes.is_empty() || !r.blobs_pulled.is_empty() {
            self.host.event(Event::Changed { notes, blobs: r.blobs_pulled.clone() });
        }
        let report = gestalts_core::push(&self.notes, remote, &mut base, pending, &g, &mut |_| {}).await?;
        if changed_anything(&report) || !self.collected.get() {
            self.collect_blobs().await?;
        }
        Ok(report)
    }

    /// Deletes blobs no note has referenced for a while (`gestalts_core::blobs`).
    async fn collect_blobs(&self) -> Result<()> {
        let path = self.dir.join("blob-gc.json");
        let mut manifest: GcManifest = read_json(&path)?.unwrap_or_default();
        if !manifest.due(now_ms()) {
            return Ok(());
        }
        let texts = self.notes.read_all_ymls().await?;
        let referenced = gestalts_core::referenced_blobs(texts.iter().map(|(k, t)| (k.as_str(), t.as_str())), &self.gestalts.borrow());
        let deleted = {
            let _w = self.writes.lock().await;
            gestalts_core::collect_blobs(&self.notes, &referenced, &mut manifest, now_ms()).await?
        };
        write_json(&path, &manifest)?;
        self.collected.set(true);
        if !deleted.is_empty() {
            self.host.event(Event::Changed { notes: vec![], blobs: deleted });
        }
        Ok(())
    }

    /// Syncs when asked to, a moment after writes, and on a timer while the app is in the foreground; one sync at a
    /// time, and one more if asked meanwhile.
    async fn schedule(self: Rc<Self>) {
        loop {
            let poll = async {
                if self.active.get() && self.paired.borrow().is_some() {
                    tokio::time::sleep(POLL).await
                } else {
                    std::future::pending().await
                }
            };
            tokio::select! {
                _ = self.now.notified() => {}
                _ = self.soon.notified() => tokio::time::sleep(WRITE_DELAY).await,
                _ = poll => {}
            }
            if self.paired.borrow().is_some() {
                // the status has the error
                let _ = self.sync().await;
            }
        }
    }
}

fn changed_anything(r: &SyncReport) -> bool {
    !(r.pulled.is_empty() && r.pushed.is_empty() && r.blobs_pulled.is_empty() && r.blobs_pushed.is_empty())
}

fn info(node: &PairedNode) -> NodeInfo {
    NodeInfo { node_id: node.node_id.clone(), name: node.name.clone() }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn now() -> String {
    gestalts_core::iso_datetime(now_ms())
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    match std::fs::read(path) {
        Ok(b) => serde_json::from_slice(&b).map(Some).map_err(|e| io(format!("{}: {e}", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io(e)),
    }
}

fn write_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value).map_err(io)?).map_err(io)?;
    std::fs::rename(&tmp, path).map_err(io)
}

fn remove(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(io(e)),
        _ => Ok(()),
    }
}

type Job = Box<dyn FnOnce(Rc<Device>) -> LocalBoxFuture<'static, ()> + Send>;

/// Starts the device whose data is in `dir` on a thread of its own, with its sync schedule.
pub fn spawn(dir: PathBuf, host: impl Host) -> Result<Handle> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Job>();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<()>>();
    std::thread::Builder::new()
        .name("gestalts-device".into())
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(rt) => rt,
                Err(e) => return drop(ready_tx.send(Err(io(e)))),
            };
            let local = tokio::task::LocalSet::new();
            local.block_on(&rt, async move {
                let device = match Device::open(&dir, Box::new(host)) {
                    Ok(d) => Rc::new(d),
                    Err(e) => return drop(ready_tx.send(Err(e))),
                };
                let _ = ready_tx.send(Ok(()));
                tokio::task::spawn_local(device.clone().schedule());
                while let Some(job) = rx.recv().await {
                    tokio::task::spawn_local(job(device.clone()));
                }
            });
        })
        .map_err(io)?;
    ready_rx.recv().map_err(io)??;
    Ok(Handle { tx })
}

/// Sends a [`Device`] jobs from any thread.
#[derive(Clone)]
pub struct Handle {
    tx: mpsc::UnboundedSender<Job>,
}

fn stopped() -> StorageError {
    io("the device stopped")
}

impl Handle {
    /// Runs `f` on the device's thread.
    pub async fn run<R: Send + 'static>(&self, f: impl FnOnce(Rc<Device>) -> LocalBoxFuture<'static, R> + Send + 'static) -> Result<R> {
        let (otx, orx) = oneshot::channel();
        let job: Job = Box::new(move |d| {
            Box::pin(async move {
                let _ = otx.send(f(d).await);
            })
        });
        self.tx.send(job).map_err(|_| stopped())?;
        orx.await.map_err(|_| stopped())
    }

    async fn try_run<R: Send + 'static>(&self, f: impl FnOnce(Rc<Device>) -> LocalBoxFuture<'static, Result<R>> + Send + 'static) -> Result<R> {
        self.run(f).await?
    }

    pub async fn set_gestalts(&self, yaml: Vec<String>) -> Result<()> {
        self.try_run(move |d| Box::pin(async move { d.set_gestalts(yaml) })).await
    }

    pub async fn list_ymls(&self) -> Result<Vec<String>> {
        self.try_run(|d| Box::pin(async move { d.notes.list_ymls().await })).await
    }

    pub async fn read_yml(&self, key: String) -> Result<Option<String>> {
        self.try_run(move |d| Box::pin(async move { d.notes.read_yml(&key).await })).await
    }

    pub async fn read_ymls(&self, keys: Vec<String>) -> Result<Vec<(String, String)>> {
        self.try_run(move |d| Box::pin(async move { d.notes.read_ymls(&keys).await })).await
    }

    pub async fn read_all_ymls(&self) -> Result<Vec<(String, String)>> {
        self.try_run(|d| Box::pin(async move { d.notes.read_all_ymls().await })).await
    }

    pub async fn yml_hashes(&self) -> Result<Hashes> {
        self.try_run(|d| Box::pin(async move { d.notes.yml_hashes().await })).await
    }

    pub async fn write_yml(&self, key: String, text: String) -> Result<()> {
        self.try_run(move |d| Box::pin(async move { d.write_yml(&key, &text).await })).await
    }

    pub async fn write_ymls(&self, notes: Vec<(String, String)>) -> Result<()> {
        self.try_run(move |d| Box::pin(async move { d.write_ymls(&notes).await })).await
    }

    pub async fn delete_yml(&self, key: String) -> Result<()> {
        self.try_run(move |d| Box::pin(async move { d.delete_yml(&key).await })).await
    }

    pub async fn list_blobs(&self) -> Result<Vec<String>> {
        self.try_run(|d| Box::pin(async move { d.notes.list_blobs().await })).await
    }

    pub async fn read_blob(&self, name: String) -> Result<Option<Vec<u8>>> {
        self.try_run(move |d| Box::pin(async move { d.notes.read_blob(&name).await })).await
    }

    pub async fn write_blob(&self, name: String, bytes: Vec<u8>) -> Result<()> {
        self.try_run(move |d| Box::pin(async move { d.write_blob(&name, &bytes).await })).await
    }

    pub async fn delete_blob(&self, name: String) -> Result<()> {
        self.try_run(move |d| Box::pin(async move { d.delete_blob(&name).await })).await
    }

    pub async fn status(&self) -> Result<Status> {
        self.run(|d| Box::pin(async move { d.status() })).await
    }

    pub async fn pair(&self, uri: String, device_name: String) -> Result<NodeInfo> {
        self.try_run(move |d| Box::pin(async move { d.pair(&uri, &device_name).await })).await
    }

    pub async fn forget(&self) -> Result<()> {
        self.try_run(|d| Box::pin(async move { d.forget() })).await
    }

    /// Asks for a sync; the status events tell how it goes.
    pub async fn sync_soon(&self) -> Result<()> {
        self.run(|d| Box::pin(async move { d.sync_soon() })).await
    }

    pub async fn set_active(&self, active: bool) -> Result<()> {
        self.run(move |d| Box::pin(async move { d.set_active(active) })).await
    }
}

#[cfg(test)]
mod tests;
