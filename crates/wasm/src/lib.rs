//! JS API of the gestalts core. Wrapped by `packages/client`; not meant to be used directly.

mod js;
mod opfs;

use std::cell::RefCell;
use std::rc::Rc;

use gestalts_core::storage::{Deck, Layered, Storage, StorageError, Tracked};
use gestalts_core::sync::{Fetched, Pending, SyncBase};
use gestalts_core::{Gestalts, IndexedNote, Note, Query, Repo, UpstreamReport, pull_upstream};
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
    upstream_report: RefCell<UpstreamReport>,
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
    /// Notes in OPFS under `dir`, over read-only decks (`[{source, url}]`, published folders, see `Static`), with the
    /// core's gestalts plus `gestalts` (YAML definitions from plugins). Decks holding the same key are merged by those
    /// gestalts' rules. Copy-on-write: deck notes the user's notes reference are copied into OPFS, and untouched
    /// copies follow deck changes (`gestalts_core::upstream`).
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
        let this = WasmRepo { repo, writable, dir, node, layered, upstream_report: RefCell::default(), sync_run: RefCell::default() };
        this.pull_upstream().await?;
        this.repo.load().await.map_err(err)?;
        Ok(this)
    }

    /// Rereads `keys` from storage, after something else changed them (a node's change events), then brings deck
    /// copies up to date. Returns every key reread, including copies that pulling upstream wrote.
    pub async fn reindex(&self, keys: Vec<String>) -> Result<Vec<String>, JsError> {
        self.pull_upstream().await?;
        let mut changed = keys;
        {
            let up = self.upstream_report.borrow();
            changed.extend(up.copied.iter().chain(&up.updated).cloned());
        }
        let repo = self.repo.clone();
        repo.reindex(&changed).await.map_err(err)?;
        Ok(changed)
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

    /// The keys of the notes copied from the decks `sources` alone (every deck in their trailer is one of them).
    #[wasm_bindgen(js_name = copiesOf)]
    pub async fn copies_of(&self, sources: Vec<String>) -> Result<Vec<String>, JsError> {
        gestalts_core::copies_of(&*self.writable, &sources).await.map_err(err)
    }

    /// Collects this browser's unreferenced blobs, after a successful sync (`gestalts_core::blobs`). The manifest
    /// lives in OPFS next to the data.
    async fn collect_blobs(&self, dir: &str) -> Result<Vec<String>, JsError> {
        let store = Opfs::open(&format!("{dir}-blob-gc")).await.map_err(err)?;
        let mut manifest: gestalts_core::GcManifest =
            store.read_note("manifest").await.map_err(err)?.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let texts = self.repo.texts();
        let referenced = gestalts_core::referenced_blobs(texts.iter().map(|(k, t)| (k.as_str(), t.as_str())), self.repo.gestalts());
        let deleted = gestalts_core::collect_blobs(&*self.writable, &referenced, &mut manifest, js_sys::Date::now() as i64).await.map_err(err)?;
        let json = serde_json::to_string(&manifest).map_err(|e| JsError::new(&e.to_string()))?;
        store.write_note("manifest", &json).await.map_err(err)?;
        Ok(deleted)
    }

    async fn pull_upstream(&self) -> Result<(), JsError> {
        if let Some(l) = &self.layered {
            *self.upstream_report.borrow_mut() = pull_upstream(&l.deck_refs(), &*self.writable).await.map_err(err)?;
        }
        Ok(())
    }

    /// What the last check against upstream did: `{copied, updated, diverged, deck_conflicts}`, all empty for a plain
    /// OPFS repo. `deck_conflicts` (`key: path`) are values mounted decks disagree on, from the last full read.
    #[wasm_bindgen(js_name = upstreamReport)]
    pub fn upstream_report(&self) -> Result<JsValue, JsError> {
        let r = self.upstream_report.borrow();
        let deck_conflicts = self.layered.as_ref().map(|l| l.deck_conflicts.borrow().clone()).unwrap_or_default();
        to_js(&UpstreamReport { copied: r.copied.clone(), updated: r.updated.clone(), diverged: r.diverged.clone(), deck_conflicts })
    }

    /// Rereads everything from storage.
    pub async fn reload(&self) -> Result<(), JsError> {
        let repo = self.repo.clone();
        repo.load().await.map_err(err)
    }

    /// `query`: `{gestalt?, gestaltsNone?, tagsAll?, tagsNone?, keys?, where?}`
    pub fn query(&self, query: JsValue) -> Result<JsValue, JsError> {
        let q: Query = if query.is_undefined() || query.is_null() {
            Query::default()
        } else {
            serde_wasm_bindgen::from_value(query).map_err(|e| JsError::new(&e.to_string()))?
        };
        to_js(&self.repo.query(&q))
    }

    pub fn get(&self, key: &str) -> Result<JsValue, JsError> {
        to_js(&self.repo.get(key))
    }

    #[wasm_bindgen(js_name = keyOf)]
    pub fn key_of(&self, id: &str) -> Option<String> {
        self.repo.key_of(id)
    }

    #[wasm_bindgen(js_name = putRaw)]
    pub async fn put_raw(&self, key: String, raw: String) -> Result<JsValue, JsError> {
        let repo = self.repo.clone();
        to_js(&repo.put_raw(&key, &raw).await.map_err(err)?)
    }

    /// `json`: the note as JSON text; without `key`, a new uuid key/id is assigned.
    #[wasm_bindgen(js_name = putValue)]
    pub async fn put_value(&self, key: Option<String>, json: String) -> Result<JsValue, JsError> {
        let value: gestalts_core::Value = serde_json::from_str(&json).map_err(|e| JsError::new(&e.to_string()))?;
        let repo = self.repo.clone();
        to_js(&repo.put_value(key.as_deref(), value).await.map_err(err)?)
    }

    /// Deletes a note by writing its tombstone, and the notes that die with it. Returns every key deleted.
    pub async fn delete(&self, key: String) -> Result<Vec<String>, JsError> {
        let repo = self.repo.clone();
        repo.delete(&key, &now()).await.map_err(err)
    }

    /// Whether `key` is a tombstone.
    #[wasm_bindgen(js_name = isDeleted)]
    pub fn is_deleted(&self, key: &str) -> bool {
        self.repo.is_deleted(key)
    }

    /// Three-way merge of one note's text as a sync does it, by this repo's gestalts: `{text, conflicts, raw}`, `text`
    /// null when the note is absent, `conflicts` the values no rule settled (`{path, base?, kept?, lost?}`; the text
    /// holds `kept`).
    pub fn merge3(&self, key: &str, base: Option<String>, local: Option<String>, remote: Option<String>) -> Result<JsValue, JsError> {
        let m = gestalts_core::merge_note(key, base.as_deref(), local.as_deref(), remote.as_deref(), self.repo.gestalts(), &now());
        let conflicts: Vec<gestalts_core::Value> = m
            .conflicts
            .iter()
            .map(|c| gestalts_core::note::parse_yaml(&gestalts_core::conflict_note(key, key, c, m.raw, &now()).1).unwrap_or_default())
            .collect();
        to_js(&serde_json::json!({ "text": m.text, "conflicts": conflicts, "raw": m.raw }))
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

    /// What saving `raw` would give, without saving: `{id, gestalts, lints, parse_error, ...}`.
    pub fn inspect(&self, key: &str, raw: &str) -> Result<JsValue, JsError> {
        let note = Note::parse(key, raw);
        let g = self.repo.gestalts();
        to_js(&IndexedNote::new(note, g))
    }

    /// What writing `json` (a note as JSON) under `key` would index as, without saving it.
    #[wasm_bindgen(js_name = inspectValue)]
    pub fn inspect_value(&self, key: Option<String>, json: String) -> Result<JsValue, JsError> {
        let value: gestalts_core::Value = serde_json::from_str(&json).map_err(|e| JsError::new(&e.to_string()))?;
        let key = key.unwrap_or_else(|| value.get("id").and_then(|v| v.as_str()).unwrap_or("new").to_owned());
        self.inspect(&key, &gestalts_core::note::to_yaml(&value))
    }

    /// Sync, phase 1 (`gestalts_core::sync`), network only: asks the connector at `connector_url` what changed since
    /// the last sync, and fetches it. Runs alongside the app's writes; `syncMerge` and `syncPush` finish it.
    #[wasm_bindgen(js_name = syncFetch)]
    pub async fn sync_fetch(&self, connector_url: String) -> Result<(), JsError> {
        let Some(dir) = &self.dir else {
            return Err(JsError::new("these notes are the node's folder already: there is nothing to sync"));
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
        self.pull_upstream().await?;
        run.mark("pull_upstream");
        // only what sync and pull_upstream wrote: the repo's own writes are indexed already
        let mut changed: Vec<String> = pending.report().pulled.iter().chain(&pending.report().conflicts).cloned().collect();
        {
            let up = self.upstream_report.borrow();
            changed.extend(up.copied.iter().chain(&up.updated).cloned());
        }
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

#[wasm_bindgen(js_name = stateKey)]
pub fn state_key(gestalt: &str, target: &str, facet: Option<String>) -> String {
    gestalts_core::state_key(gestalt, target, facet.as_deref())
}

/// What identifies a card within its note (dsl's `card_id`).
#[wasm_bindgen(js_name = cardId)]
pub fn card_id(front: &str) -> String {
    gestalts_core::card_id(front)
}

/// Hex sha256 of a text.
#[wasm_bindgen(js_name = contentHash)]
pub fn content_hash(text: &str) -> String {
    gestalts_core::content_hash(text.as_bytes())
}

/// BibTeX text as sources: `[{source, warnings}]`.
#[wasm_bindgen(js_name = bibParse)]
pub fn bib_parse(text: &str) -> Result<JsValue, JsError> {
    to_js(&gestalts_core::bib::parse(text).map_err(|e| JsError::new(&e))?)
}

/// Sources (note values) as biblatex text.
#[wasm_bindgen(js_name = bibWrite)]
pub fn bib_write(sources: JsValue) -> Result<String, JsError> {
    Ok(gestalts_core::bib::write(&from_js::<Vec<serde_json::Map<String, serde_json::Value>>>(sources)?))
}

/// The existing sources (`[{key, source}]`) that may be `entry`, best first: `[{key, level, reasons}]`.
#[wasm_bindgen(js_name = bibMatches)]
pub fn bib_matches(entry: JsValue, sources: JsValue, limit: usize) -> Result<JsValue, JsError> {
    #[derive(serde::Deserialize)]
    struct Existing {
        key: String,
        source: serde_json::Map<String, serde_json::Value>,
    }
    let existing: Vec<Existing> = from_js(sources)?;
    let existing: Vec<_> = existing.into_iter().map(|e| (e.key, e.source)).collect();
    to_js(&gestalts_core::bib::matches(&from_js(entry)?, &existing, limit))
}

/// `current` updated from `incoming`: `{source, filled, conflicts}`; fields in `take` are replaced.
#[wasm_bindgen(js_name = bibMerge)]
pub fn bib_merge(current: JsValue, incoming: JsValue, take: Vec<String>) -> Result<JsValue, JsError> {
    to_js(&gestalts_core::bib::merge(&from_js(current)?, &from_js(incoming)?, &take))
}

#[wasm_bindgen(js_name = bibUniqueCitekey)]
pub fn bib_unique_citekey(key: &str, taken: Vec<String>) -> String {
    gestalts_core::bib::unique_citekey(key, &taken.into_iter().collect())
}

/// The keys a Typst document cites, in order.
#[wasm_bindgen(js_name = bibCitedKeys)]
pub fn bib_cited_keys(text: &str) -> Vec<String> {
    gestalts_core::bib::cited_keys(text)
}

/// `{entryTypes: [[type, [field…]]…], fields: [[field, kind]…]}`
#[wasm_bindgen(js_name = bibModel)]
pub fn bib_model() -> Result<JsValue, JsError> {
    to_js(&serde_json::json!({ "entryTypes": gestalts_core::bib::ENTRY_TYPES, "fields": gestalts_core::bib::FIELDS }))
}

fn from_js<T: serde::de::DeserializeOwned>(v: JsValue) -> Result<T, JsError> {
    serde_wasm_bindgen::from_value(v).map_err(|e| JsError::new(&e.to_string()))
}
