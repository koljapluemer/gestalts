//! JS API of the gestalts core. Wrapped by `packages/client`; not meant to be used directly.

mod http;
mod opfs;

use std::cell::RefCell;
use std::rc::Rc;

use gestalts_core::storage::{Deck, Layered, Storage, StorageError};
use gestalts_core::{Gestalts, IndexedNote, Note, Query, Repo, UpstreamReport, pull_upstream};
use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::http::{Connector, Static};
use crate::opfs::Opfs;

type Dyn = Rc<dyn Storage>;

fn err(e: StorageError) -> JsError {
    JsError::new(&e.to_string())
}

fn to_js<T: Serialize>(v: &T) -> Result<JsValue, JsError> {
    v.serialize(&serde_wasm_bindgen::Serializer::json_compatible()).map_err(|e| JsError::new(&e.to_string()))
}

/// A repo over browser storage. Every method returning data hands out plain JSON-like objects.
#[wasm_bindgen]
pub struct WasmRepo {
    repo: Rc<Repo<Dyn>>,
    /// where this repo's own writes land, and what syncs with a connector
    writable: Dyn,
    /// OPFS folder name, used to keep sync base snapshots next to the data
    dir: String,
    /// the storage with its decks, when it has any
    layered: Option<Rc<Layered<Dyn, Dyn>>>,
    upstream_report: RefCell<UpstreamReport>,
}

#[wasm_bindgen]
impl WasmRepo {
    /// Notes in OPFS under `dir`, over read-only decks (`[{source, aliases, url}]`, published folders, see
    /// `Static`), with the core's gestalts plus `gestalts` (YAML definitions from plugins). Copy-on-write: deck notes
    /// the user's notes reference are copied into OPFS, and untouched copies follow deck changes
    /// (`gestalts_core::upstream`).
    pub async fn open(dir: String, decks: JsValue, gestalts: Vec<String>) -> Result<WasmRepo, JsError> {
        #[derive(serde::Deserialize)]
        struct DeckSpec {
            source: String,
            #[serde(default)]
            aliases: Vec<String>,
            url: String,
        }
        let specs: Vec<DeckSpec> = if decks.is_undefined() || decks.is_null() { vec![] } else { from_js(decks)? };
        let g = Gestalts::builtin_with(&gestalts.iter().map(String::as_str).collect::<Vec<_>>()).map_err(|e| JsError::new(&e))?;
        let writable: Dyn = Rc::new(Opfs::open(&dir).await.map_err(err)?);
        let mut mounted = Vec::new();
        for d in specs {
            let storage: Dyn = Rc::new(Static::open(&d.url).await.map_err(err)?);
            mounted.push(Deck { source: d.source, aliases: d.aliases, storage });
        }
        if mounted.is_empty() {
            return Self::build(writable.clone(), writable, dir, None, g).await;
        }
        let layered = Rc::new(Layered { decks: mounted, top: writable.clone() });
        Self::build(layered.clone(), writable, dir, Some(layered), g).await
    }

    async fn build(storage: Dyn, writable: Dyn, dir: String, layered: Option<Rc<Layered<Dyn, Dyn>>>, gestalts: Gestalts) -> Result<WasmRepo, JsError> {
        let repo = Rc::new(Repo::new(storage, gestalts));
        let this = WasmRepo { repo, writable, dir, layered, upstream_report: RefCell::default() };
        this.pull_upstream().await?;
        this.repo.load().await.map_err(err)?;
        Ok(this)
    }

    /// The keys of the notes copied from the deck `source` (or its `aliases`).
    #[wasm_bindgen(js_name = copiesOf)]
    pub async fn copies_of(&self, source: String, aliases: Vec<String>) -> Result<Vec<String>, JsError> {
        gestalts_core::copies_of(&*self.writable, &source, &aliases).await.map_err(err)
    }

    /// Collects this browser's unreferenced blobs, after a successful sync (`gestalts_core::blobs`). The manifest
    /// lives in OPFS next to the data.
    async fn collect_blobs(&self) -> Result<Vec<String>, JsError> {
        let store = Opfs::open(&format!("{}-blob-gc", self.dir)).await.map_err(err)?;
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

    /// What the last check against upstream did: `{copied, updated, diverged}`, all empty for a plain OPFS repo.
    #[wasm_bindgen(js_name = upstreamReport)]
    pub fn upstream_report(&self) -> Result<JsValue, JsError> {
        to_js(&*self.upstream_report.borrow())
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

    /// Syncs this repo's writable notes and blobs with a connector, then reloads.
    /// Returns the sync report plus `folder`, the path of the connector's open folder.
    pub async fn sync(&self, connector_url: String) -> Result<JsValue, JsError> {
        // ms per step, for the debug log
        let mut timings = serde_json::Map::new();
        let mut last = js_sys::Date::now();
        let mut mark = |name: &str| {
            let now = js_sys::Date::now();
            timings.insert(name.to_owned(), ((now - last).round() as i64).into());
            last = now;
        };
        let remote = Connector::new(&connector_url);
        let health = remote.health().await.map_err(err)?;
        mark("health");
        let folder = &health["folder"];
        let (Some(folder_id), Some(folder_path)) = (folder["id"].as_str(), folder["path"].as_str()) else {
            return Err(JsError::new("The connector has no folder open yet. Choose one in the Gestalts Connector."));
        };
        // the base is per folder: the same connector URL may serve a different folder later, and
        // comparing against another folder's base would read its missing notes as deletions
        let slug: String = format!("{connector_url}#{folder_id}").chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
        let base = Opfs::open(&format!("{}-sync-base/{slug}", self.dir)).await.map_err(err)?;
        mark("open_base");
        let report = gestalts_core::sync_with(&*self.writable, &remote, &base, self.repo.gestalts(), &now(), &mut mark).await.map_err(err)?;
        self.pull_upstream().await?;
        mark("pull_upstream");
        // only what sync and pull_upstream wrote: the repo's own writes are indexed already
        let mut changed: Vec<String> = report.pulled.iter().chain(&report.conflicts).cloned().collect();
        {
            let up = self.upstream_report.borrow();
            changed.extend(up.copied.iter().chain(&up.updated).cloned());
        }
        let repo = self.repo.clone();
        repo.reindex(&changed).await.map_err(err)?;
        mark("reindex");
        let collected = self.collect_blobs().await?;
        let collected_remote = remote.collect_blobs().await.unwrap_or_default();
        mark("collect_blobs");
        let mut out = serde_json::to_value(&report).map_err(|e| JsError::new(&e.to_string()))?;
        out["folder"] = folder_path.into();
        out["blobs_collected"] = serde_json::json!({ "local": collected, "remote": collected_remote });
        out["timings"] = timings.into();
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
