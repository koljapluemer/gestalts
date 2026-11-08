//! Change events: the open folder is watched on disk, so the web apps learn about every change to it, whether it came
//! through the node API (another app, a worker) or from outside (a hand edit, a file sync tool). The events go out
//! over the `/events` WebSocket (`server.rs`).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tokio::sync::broadcast;

use crate::server::FolderInfo;

/// Changes that arrive this close together go out as one event.
const DEBOUNCE: Duration = Duration::from_millis(100);
const MAX_DELAY: Duration = Duration::from_secs(1);

/// One message on `/events`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Event {
    /// ymls (ids) and blobs (names) that were written or removed
    Changed { ymls: Vec<String>, blobs: Vec<String> },
    /// another folder is open now (or none)
    Folder(Option<FolderInfo>),
    /// this client missed events: reread everything
    Reload,
}

enum Change {
    Yml(String),
    Blob(String),
}

/// Fans the changes of whichever folder is open out to every `/events` client.
#[derive(Clone)]
pub struct Events {
    changes: mpsc::Sender<Change>,
    out: broadcast::Sender<Event>,
}

impl Default for Events {
    fn default() -> Self {
        let (changes, rx) = mpsc::channel::<Change>();
        let (out, _) = broadcast::channel(256);
        let sender = out.clone();
        std::thread::Builder::new()
            .name("gestalts-watch".into())
            .spawn(move || debounce(&rx, &sender))
            .expect("can start the watch thread");
        Events { changes, out }
    }
}

impl Events {
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.out.subscribe()
    }

    pub fn send(&self, event: Event) {
        // nobody listening is fine
        let _ = self.out.send(event);
    }

    /// Watches `root` (a data folder) until the returned watcher is dropped. `None` (and a message on stderr) if the
    /// OS won't let us: then the apps only miss live updates.
    pub fn watch(&self, root: &Path) -> Option<RecommendedWatcher> {
        let changes = self.changes.clone();
        let (notes, blobs) = (root.join("notes"), root.join("blobs"));
        let handler = move |result: notify::Result<notify::Event>| {
            let Ok(event) = result else { return };
            if event.kind.is_access() { return; }
            for path in &event.paths {
                if let Some(change) = classify(path, &notes, &blobs) {
                    let _ = changes.send(change);
                }
            }
        };
        let watched = (|| {
            let mut watcher = notify::recommended_watcher(handler)?;
            watcher.watch(&root.join("notes"), RecursiveMode::NonRecursive)?;
            watcher.watch(&root.join("blobs"), RecursiveMode::NonRecursive)?;
            Ok::<_, notify::Error>(watcher)
        })();
        watched.map_err(|e| eprintln!("gestalts-node: not watching {} for changes: {e}", root.display())).ok()
    }
}

/// A note or blob file, by the same rules as `FsStorage` (no hidden files, so not its temporary files either).
fn classify(path: &Path, notes: &Path, blobs: &Path) -> Option<Change> {
    let dir: PathBuf = path.parent()?.into();
    let name = path.file_name()?.to_str()?;
    if name.starts_with('.') { return None; }
    if dir == notes {
        gestalts_core::storage::yml_id_from_file(name).map(|k| Change::Yml(k.to_owned()))
    } else if dir == blobs {
        Some(Change::Blob(name.to_owned()))
    } else {
        None
    }
}

fn debounce(rx: &mpsc::Receiver<Change>, out: &broadcast::Sender<Event>) {
    while let Ok(first) = rx.recv() {
        let (mut ymls, mut blobs) = (BTreeSet::new(), BTreeSet::new());
        let mut add = |c: Change| match c {
            Change::Yml(k) => { ymls.insert(k); }
            Change::Blob(b) => { blobs.insert(b); }
        };
        add(first);
        // a steady stream of changes (a big sync) still goes out every so often
        let until = std::time::Instant::now() + MAX_DELAY;
        while let Some(left) = until.checked_duration_since(std::time::Instant::now())
            && let Ok(more) = rx.recv_timeout(left.min(DEBOUNCE)) { add(more); }
        let _ = out.send(Event::Changed { ymls: ymls.into_iter().collect(), blobs: blobs.into_iter().collect() });
    }
}
