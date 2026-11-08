//! JS API of the gestalts core. Wrapped by `packages/client`; not meant to be used directly.

mod js;
mod opfs;

use std::cell::RefCell;
use std::rc::Rc;

use gestalts_core::storage::{Deck, Layered, Storage, StorageError, Tracked};
use gestalts_core::sync::{Fetched, Pending, SyncBase};
use gestalts_core::{Gestalts, Query, Repo};
use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::js::{HostStorage, JsStorage};
use crate::opfs::Opfs;
use gestalts_peer::{Peer, Static};

type Dyn = Rc<dyn Storage>;

fn err(e: StorageError) -> JsError {
    JsError::new(&e.to_string())
}

fn to_js<T: Serialize>(v: &T) -> Result<JsValue, JsError> {
    v.serialize(&serde_wasm_bindgen::Serializer::json_compatible()).map_err(|e| JsError::new(&e.to_string()))
}

/// A repo over browser storage, or directly over a node's folder. Every method returning data hands out plain
/// JSON-like objects.
#[wasm_bindgen]
pub struct WasmRepo {
    repo: Rc<Repo<Dyn>>,
    /// where this repo's own writes land, and what syncs with a connector
    writable: Dyn,
    /// OPFS folder name, used to keep sync base snapshots next to the data; `None` when the notes are a node's
    dir: Option<String>,
    /// the node whose folder the notes are, when they are
    node: Option<Rc<Peer>>,
    /// the storage with its decks, when it has any
    layered: Option<Rc<Layered<Dyn, Dyn>>>,
    /// the sync between `syncFetch` and `syncPush`
    sync_run: RefCell<Option<SyncRun>>,
}

/// A sync in progress: its phases run as three calls, so the app's writes can go ahead while it waits on the network.
struct SyncRun {
    remote: Peer,
    base: SyncBase<Opfs>,
    folder: String,
    fetched: Option<Fetched>,
    pending: Option<Pending>,
    /// ms per step, for the debug log
    timings: serde_json::Map<String, serde_json::Value>,
    last: f64,
}

impl SyncRun {
    fn mark(&mut self, name: &str) {
        let now = js_sys::Date::now();
        self.timings.insert(name.to_owned(), ((now - self.last).round() as i64).into());
        self.last = now;
    }
}

/// `step` callbacks into a run's timings.
fn marker(timings: &mut serde_json::Map<String, serde_json::Value>, last: &mut f64) -> impl FnMut(&str) {
    move |name: &str| {
        let now = js_sys::Date::now();
        timings.insert(name.to_owned(), ((now - *last).round() as i64).into());
        *last = now;
    }
}

#[wasm_bindgen]
impl WasmRepo {
    /// Ymls in OPFS under `dir`, over read-only decks (`[{source, url}]`, published folders, see `Static`), with the
    /// core's gestalts plus `gestalts` (YAML definitions from plugins).
    pub async fn open(dir: String, decks: JsValue, gestalts: Vec<String>) -> Result<WasmRepo, JsError> {
        // tracked, so a sync knows which notes changed without reading them all
        let writable: Dyn = Rc::new(Tracked::new(Opfs::open(&dir).await.map_err(err)?));
        Self::build(writable, Some(dir), None, decks, gestalts).await
    }

    /// Like `open`, but the notes are the folder a node serves at `url` (the desktop app, usually this page's own
    /// origin): every write goes straight to it, and nothing syncs.
    #[wasm_bindgen(js_name = openNode)]
    pub async fn open_node(url: String, decks: JsValue, gestalts: Vec<String>) -> Result<WasmRepo, JsError> {
        let node = Rc::new(Peer::new(&url));
        Self::build(node.clone(), None, Some(node), decks, gestalts).await
    }

    /// Like `open`, but the notes are wherever `storage` keeps them (a native app's folder, over IPC): every write
    /// goes straight to it, and the host syncs it, telling the page what changed (`reindex`).
    #[wasm_bindgen(js_name = openWith)]
    pub async fn open_with(storage: HostStorage, decks: JsValue, gestalts: Vec<String>) -> Result<WasmRepo, JsError> {
        Self::build(Rc::new(JsStorage::new(storage)), None, None, decks, gestalts).await
    }

    async fn build(writable: Dyn, dir: Option<String>, node: Option<Rc<Peer>>, decks: JsValue, gestalts: Vec<String>) -> Result<WasmRepo, JsError> {
        #[derive(serde::Deserialize)]
        struct DeckSpec {
            source: String,
            url: String,
        }
        let specs: Vec<DeckSpec> = if decks.is_undefined() || decks.is_null() { vec![] } else { from_js(decks)? };
        let g = Gestalts::builtin_with(&gestalts.iter().map(String::as_str).collect::<Vec<_>>()).map_err(|e| JsError::new(&e))?;
        let mut mounted = Vec::new();
        let gestalts_for_decks = g.clone();
        for d in specs {
            let storage: Dyn = Rc::new(Static::open(&d.url).await.map_err(err)?);
            mounted.push(Deck { source: d.source, storage });
        }
        let (storage, layered) = if mounted.is_empty() {
            (writable.clone(), None)
        } else {
            let layered = Rc::new(Layered::new(mounted, writable.clone(), gestalts_for_decks));
            (layered.clone() as Dyn, Some(layered))
        };
        let repo = Rc::new(Repo::new(storage, g));
        let this = WasmRepo { repo, writable, dir, node, layered, sync_run: RefCell::default() };
        this.repo.load().await.map_err(err)?;
        Ok(this)
    }

    /// Rereads `ids` from storage, after something else changed them (a node's change events). Only subscriptions
    /// these concern get a delta.
    pub async fn reindex(&self, ids: Vec<String>) -> Result<(), JsError> {
        let repo = self.repo.clone();
        repo.reindex(&ids).await.map_err(err)
    }

    /// For a repo on a node's folder: asks the node to collect the folder's unreferenced blobs (`POST
    /// /blobs/collect`); the names it deleted.
    #[wasm_bindgen(js_name = collectNodeBlobs)]
    pub async fn collect_node_blobs(&self) -> Result<Vec<String>, JsError> {
        match &self.node {
            Some(node) => node.collect_blobs().await.map_err(err),
            None => Ok(vec![]),
        }
    }

    /// Collects this browser's unreferenced blobs, after a successful sync (`gestalts_core::blobs`). The manifest
    /// lives in OPFS next to the data.
    async fn collect_blobs(&self, dir: &str) -> Result<Vec<String>, JsError> {
        let store = Opfs::open(&format!("{dir}-blob-gc")).await.map_err(err)?;
        let mut manifest: gestalts_core::GcManifest =
            store.read_yml("manifest").await.map_err(err)?.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let now = js_sys::Date::now() as i64;
        if !manifest.due(now) {
            return Ok(vec![]);
        }
        let deleted = gestalts_core::collect_blobs(&*self.writable, &self.repo.blob_refs(), &mut manifest, now).await.map_err(err)?;
        let json = serde_json::to_string(&manifest).map_err(|e| JsError::new(&e.to_string()))?;
        store.write_yml("manifest", &json).await.map_err(err)?;
        Ok(deleted)
    }

    /// What mounted decks disagree on, as `id: path`, from the last full read.
    #[wasm_bindgen(js_name = deckConflicts)]
    pub fn deck_conflicts(&self) -> Vec<String> {
        self.layered.as_ref().map(|l| l.deck_conflicts.borrow().clone()).unwrap_or_default()
    }

    /// One page of what `query` asks for (`gestalts_core::Query`): `{items, next}`.
    pub fn query(&self, query: JsValue) -> Result<JsValue, JsError> {
        to_js(&self.repo.query(&from_js::<Query>(query)?))
    }

    pub fn get(&self, id: &str) -> Result<JsValue, JsError> {
        to_js(&self.repo.get(id))
    }

    /// Starts a live query: `{sub, page}`. Changes come out of `takeDeltas`.
    pub fn subscribe(&self, query: JsValue) -> Result<JsValue, JsError> {
        let (sub, page) = self.repo.subscribe(from_js::<Query>(query)?);
        to_js(&serde_json::json!({ "sub": sub, "page": page }))
    }

    pub fn unsubscribe(&self, sub: f64) {
        self.repo.unsubscribe(sub as u64);
    }

    /// The deltas since last asked: `[{sub, upsert, remove, order, next}]`.
    #[wasm_bindgen(js_name = takeDeltas)]
    pub fn take_deltas(&self) -> Result<JsValue, JsError> {
        to_js(&self.repo.take_deltas())
    }

    /// `json`: the yml as JSON text. Refused unless valid by its gestalt; without `id`, it gets a new uuid.
    pub async fn put(&self, json: String) -> Result<JsValue, JsError> {
        let value: gestalts_core::Value = serde_json::from_str(&json).map_err(|e| JsError::new(&e.to_string()))?;
        let repo = self.repo.clone();
        to_js(&repo.put(value).await.map_err(err)?)
    }

    /// Deletes a yml by writing its tombstone. Returns whether there was one to delete.
    pub async fn delete(&self, id: String) -> Result<bool, JsError> {
        let repo = self.repo.clone();
        repo.delete(&id, &now()).await.map_err(err)
    }

    /// Every yml that can't be used, and why: `[{id, problems}]`.
    pub fn health(&self) -> Result<JsValue, JsError> {
        to_js(&self.repo.health())
    }

    #[wasm_bindgen(js_name = readBlob)]
    pub async fn read_blob(&self, name: String) -> Result<Option<Vec<u8>>, JsError> {
        let repo = self.repo.clone();
        repo.storage().read_blob(&name).await.map_err(err)
    }

    #[wasm_bindgen(js_name = writeBlob)]
    pub async fn write_blob(&self, name: String, bytes: Vec<u8>) -> Result<(), JsError> {
        let repo = self.repo.clone();
        repo.storage().write_blob(&name, &bytes).await.map_err(err)
    }

    /// All gestalt definitions.
    pub fn gestalts(&self) -> Result<JsValue, JsError> {
        to_js(&self.repo.gestalts().defs())
    }

    /// Sync, phase 1 (`gestalts_core::sync`), network only: asks the connector at `connector_url` what changed since
    /// the last sync, and fetches it. Runs alongside the app's writes; `syncMerge` and `syncPush` finish it.
    #[wasm_bindgen(js_name = syncFetch)]
    pub async fn sync_fetch(&self, connector_url: String) -> Result<(), JsError> {
        let Some(dir) = &self.dir else {
            return Err(JsError::new("these ymls are the node's folder already: there is nothing to sync"));
        };
        self.sync_run.borrow_mut().take();
        let mut timings = serde_json::Map::new();
        let mut last = js_sys::Date::now();
        let remote = Peer::new(&connector_url);
        let health = remote.health().await.map_err(err)?;
        let folder = &health["folder"];
        let (Some(folder_id), Some(folder_path)) = (folder["id"].as_str(), folder["path"].as_str()) else {
            return Err(JsError::new("The desktop app has no folder open yet. Choose one in the Gestalter."));
        };
        marker(&mut timings, &mut last)("health");
        // the base is per folder: the same connector URL may serve a different folder later, and
        // comparing against another folder's base would read its missing notes as deletions
        let slug: String = format!("{connector_url}#{folder_id}").chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
        let base = SyncBase::open(Opfs::open(&format!("{dir}-sync-base/{slug}")).await.map_err(err)?).await.map_err(err)?;
        marker(&mut timings, &mut last)("open_base");
        let fetched =
            gestalts_core::fetch_remote(&*self.writable, &remote, &base, self.repo.gestalts(), &mut marker(&mut timings, &mut last)).await.map_err(err)?;
        let run = SyncRun { remote, base, folder: folder_path.to_owned(), fetched: Some(fetched), pending: None, timings, last };
        *self.sync_run.borrow_mut() = Some(run);
        Ok(())
    }

    /// Sync, phase 2, local only (run it in the app's write queue): merges, writes the merged notes here, and
    /// rereads them. Returns the keys it changed here.
    #[wasm_bindgen(js_name = syncMerge)]
    pub async fn sync_merge(&self) -> Result<Vec<String>, JsError> {
        let mut run = self.sync_run.borrow_mut().take().ok_or_else(|| JsError::new("syncFetch first"))?;
        let fetched = run.fetched.take().ok_or_else(|| JsError::new("syncFetch first"))?;
        let (mut timings, mut last) = (std::mem::take(&mut run.timings), run.last);
        let pending = gestalts_core::merge_local(&*self.writable, &run.remote, &mut run.base, fetched, self.repo.gestalts(), &now(),
                                                 &mut marker(&mut timings, &mut last)).await.map_err(err)?;
        (run.timings, run.last) = (timings, last);
        // only what sync wrote: the repo's own writes are indexed already
        let changed: Vec<String> = pending.report().pulled.iter().chain(&pending.report().conflicts).cloned().collect();
        let repo = self.repo.clone();
        repo.reindex(&changed).await.map_err(err)?;
        run.mark("reindex");
        run.pending = Some(pending);
        *self.sync_run.borrow_mut() = Some(run);
        Ok(changed)
    }

    /// Sync, phase 3, network only: pushes what the merge left, then collects unreferenced blobs on both sides.
    /// Returns the sync report plus `folder`, the path of the connector's open folder.
    #[wasm_bindgen(js_name = syncPush)]
    pub async fn sync_push(&self) -> Result<JsValue, JsError> {
        let mut run = self.sync_run.borrow_mut().take().ok_or_else(|| JsError::new("syncMerge first"))?;
        let pending = run.pending.take().ok_or_else(|| JsError::new("syncMerge first"))?;
        let (mut timings, mut last) = (std::mem::take(&mut run.timings), run.last);
        let report = gestalts_core::push(&*self.writable, &run.remote, &mut run.base, pending, self.repo.gestalts(),
                                         &mut marker(&mut timings, &mut last)).await.map_err(err)?;
        (run.timings, run.last) = (timings, last);
        let dir = self.dir.clone().unwrap_or_default();
        let collected = self.collect_blobs(&dir).await?;
        let collected_remote = run.remote.collect_blobs().await.unwrap_or_default();
        run.mark("collect_blobs");
        let mut out = serde_json::to_value(&report).map_err(|e| JsError::new(&e.to_string()))?;
        out["folder"] = run.folder.into();
        out["blobs_collected"] = serde_json::json!({ "local": collected, "remote": collected_remote });
        out["timings"] = run.timings.into();
        to_js(&out)
    }
}

/// The current time as an ISO datetime, for tombstones and conflict records.
fn now() -> String {
    String::from(js_sys::Date::new_0().to_iso_string())
}

#[wasm_bindgen(js_name = newId)]
pub fn new_id() -> String {
    gestalts_core::new_id()
}

#[wasm_bindgen(js_name = stableId)]
pub fn stable_id(namespace: &str, name: &str) -> String {
    gestalts_core::stable_id(namespace, name)
}

#[wasm_bindgen(js_name = stateId)]
pub fn state_id(gestalt: &str, target: &str, facet: Option<String>) -> String {
    gestalts_core::state_id(gestalt, target, facet.as_deref())
}

/// Hex sha256 of a text.
#[wasm_bindgen(js_name = contentHash)]
pub fn content_hash(text: &str) -> String {
    gestalts_core::content_hash(text.as_bytes())
}

fn from_js<T: serde::de::DeserializeOwned>(v: JsValue) -> Result<T, JsError> {
    serde_wasm_bindgen::from_value(v).map_err(|e| JsError::new(&e.to_string()))
}
