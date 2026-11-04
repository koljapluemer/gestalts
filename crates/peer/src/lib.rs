//! Storage over HTTP: [`Peer`], another device's node, and [`Static`], a published deck. Compiles for the browser
//! (`fetch`) and natively (reqwest, which needs a tokio runtime).

mod fetch;
#[cfg(not(target_arch = "wasm32"))]
pub mod paired;

use async_trait::async_trait;
use gestalts_core::storage::{Hashes, Result, Storage, StorageError, check_key};
use serde::{Deserialize, Serialize};

pub use crate::fetch::Auth;
use crate::fetch::{Body, Payload, enc, fetch, json, send};

/// A gestalt data folder published as static files, with an `index.json` of `{notes: [keys], blobs: [names]}`.
pub struct Static {
    base: String,
    index: Index,
}

#[derive(Deserialize, Default)]
struct Index {
    notes: Vec<String>,
    blobs: Vec<String>,
}

impl Static {
    pub async fn open(base: &str) -> Result<Self> {
        let base = base.trim_end_matches('/').to_owned();
        let index = match fetch(&format!("{base}/index.json"), "GET", None).await? {
            Some(r) => json(r).await?,
            None => Index::default(),
        };
        Ok(Static { base, index })
    }
}

#[async_trait(?Send)]
impl Storage for Static {
    async fn list_notes(&self) -> Result<Vec<String>> {
        Ok(self.index.notes.clone())
    }
    async fn read_note(&self, key: &str) -> Result<Option<String>> {
        check_key(key)?;
        // the index is complete: asking the server for anything else is a 404 per lookup (copy-on-write looks up
        // every key the user's notes reference)
        if !self.index.notes.iter().any(|n| n == key) {
            return Ok(None);
        }
        match fetch(&format!("{}/notes/{}.yml", self.base, enc(key)), "GET", None).await? {
            Some(r) => Ok(Some(r.text().await?)),
            None => Ok(None),
        }
    }
    async fn write_note(&self, _: &str, _: &str) -> Result<()> {
        Err(StorageError::ReadOnly)
    }
    async fn delete_note(&self, _: &str) -> Result<()> {
        Err(StorageError::ReadOnly)
    }
    async fn list_blobs(&self) -> Result<Vec<String>> {
        Ok(self.index.blobs.clone())
    }
    async fn read_blob(&self, name: &str) -> Result<Option<Vec<u8>>> {
        check_key(name)?;
        if !self.index.blobs.iter().any(|b| b == name) {
            return Ok(None);
        }
        match fetch(&format!("{}/blobs/{}", self.base, enc(name)), "GET", None).await? {
            Some(r) => Ok(Some(r.bytes().await?)),
            None => Ok(None),
        }
    }
    async fn write_blob(&self, _: &str, _: &[u8]) -> Result<()> {
        Err(StorageError::ReadOnly)
    }
    async fn delete_blob(&self, _: &str) -> Result<()> {
        Err(StorageError::ReadOnly)
    }
    async fn read_all_notes(&self) -> Result<Vec<(String, String)>> {
        let texts = futures::future::try_join_all(self.index.notes.iter().map(|k| self.read_note(k))).await?;
        Ok(self.index.notes.iter().cloned().zip(texts).filter_map(|(k, t)| Some((k, t?))).collect())
    }
}

/// Another device's node (`gestalts-node`, the desktop app's "connector"), over its node API: see `doc/node.md`.
pub struct Peer {
    base: String,
    auth: Auth,
    /// the node has `/sync/*` (API 2); cleared when it answers 404, so an older node still syncs
    batch: std::cell::Cell<bool>,
}

#[derive(Serialize, Deserialize)]
struct NoteEntry {
    key: String,
    text: String,
}

impl Peer {
    pub fn new(base: &str) -> Self {
        Self::with_auth(base, Auth::default())
    }

    /// A node reached with `auth`: a paired node over the network (`paired.rs`).
    pub fn with_auth(base: &str, auth: Auth) -> Self {
        Peer { base: base.trim_end_matches('/').to_owned(), auth, batch: std::cell::Cell::new(true) }
    }

    pub fn url(&self) -> &str {
        &self.base
    }

    async fn req(&self, path: &str, method: &str, body: Option<Payload<'_>>) -> Result<Option<Body>> {
        send(&self.auth, &format!("{}{path}", self.base), method, body).await
    }

    /// A `/sync/*` request; `None` from a node without them.
    async fn batch_req(&self, path: &str, method: &str, body: Option<Payload<'_>>) -> Result<Option<Body>> {
        if !self.batch.get() {
            return Ok(None);
        }
        let r = self.req(path, method, body).await?;
        if r.is_none() {
            self.batch.set(false);
        }
        Ok(r)
    }

    /// Asks the node to collect the folder's unreferenced blobs; the names it deleted. An older node
    /// without the endpoint collects nothing.
    pub async fn collect_blobs(&self) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct Collected {
            deleted: Vec<String>,
        }
        match self.req("/blobs/collect", "POST", Some(Payload::Bytes(&[]))).await {
            Ok(Some(r)) => Ok(json::<Collected>(r).await.map(|c| c.deleted).unwrap_or_default()),
            _ => Ok(vec![]),
        }
    }

    /// Fails unless a node answers at the URL.
    pub async fn health(&self) -> Result<serde_json::Value> {
        let r = self.req("/health", "GET", None).await?.ok_or_else(|| StorageError::Io("no node there".into()))?;
        json(r).await
    }
}

#[async_trait(?Send)]
impl Storage for Peer {
    async fn list_notes(&self) -> Result<Vec<String>> {
        Ok(self.read_all_notes().await?.into_iter().map(|(k, _)| k).collect())
    }
    async fn read_note(&self, key: &str) -> Result<Option<String>> {
        match self.req(&format!("/notes/{}", enc(key)), "GET", None).await? {
            Some(r) => Ok(Some(r.text().await?)),
            None => Ok(None),
        }
    }
    async fn write_note(&self, key: &str, text: &str) -> Result<()> {
        self.req(&format!("/notes/{}", enc(key)), "PUT", Some(Payload::Bytes(text.as_bytes()))).await.map(drop)
    }
    async fn delete_note(&self, key: &str) -> Result<()> {
        self.req(&format!("/notes/{}", enc(key)), "DELETE", None).await.map(drop)
    }
    async fn list_blobs(&self) -> Result<Vec<String>> {
        match self.req("/blobs", "GET", None).await? {
            Some(r) => json(r).await,
            None => Ok(vec![]),
        }
    }
    async fn read_blob(&self, name: &str) -> Result<Option<Vec<u8>>> {
        match self.req(&format!("/blobs/{}", enc(name)), "GET", None).await? {
            Some(r) => Ok(Some(r.bytes().await?)),
            None => Ok(None),
        }
    }
    async fn write_blob(&self, name: &str, data: &[u8]) -> Result<()> {
        self.req(&format!("/blobs/{}", enc(name)), "PUT", Some(Payload::Bytes(data))).await.map(drop)
    }
    async fn delete_blob(&self, name: &str) -> Result<()> {
        self.req(&format!("/blobs/{}", enc(name)), "DELETE", None).await.map(drop)
    }
    async fn read_all_notes(&self) -> Result<Vec<(String, String)>> {
        let r = self.req("/notes", "GET", None).await?.ok_or_else(|| StorageError::Io("no /notes".into()))?;
        let entries: Vec<NoteEntry> = json(r).await?;
        Ok(entries.into_iter().map(|e| (e.key, e.text)).collect())
    }
    async fn note_hashes(&self) -> Result<Hashes> {
        match self.batch_req("/sync/hashes", "GET", None).await? {
            Some(r) => json(r).await,
            None => Ok(self.read_all_notes().await?.into_iter().map(|(k, t)| (k, gestalts_core::content_hash(t.as_bytes()))).collect()),
        }
    }
    async fn read_notes(&self, keys: &[String]) -> Result<Vec<(String, String)>> {
        let mut out = Vec::new();
        // in chunks, so a first sync of a large folder doesn't make one huge response
        for chunk in keys.chunks(500) {
            let body = serde_json::to_vec(&serde_json::json!({ "keys": chunk })).map_err(|e| StorageError::Io(e.to_string()))?;
            match self.batch_req("/sync/read", "POST", Some(Payload::Json(body))).await? {
                Some(r) => out.extend(json::<Vec<NoteEntry>>(r).await?.into_iter().map(|e| (e.key, e.text))),
                None => {
                    for key in chunk {
                        if let Some(t) = self.read_note(key).await? {
                            out.push((key.clone(), t));
                        }
                    }
                }
            }
        }
        Ok(out)
    }
    async fn write_notes(&self, notes: &[(String, String)]) -> Result<()> {
        for chunk in notes.chunks(500) {
            let entries: Vec<NoteEntry> = chunk.iter().map(|(key, text)| NoteEntry { key: key.clone(), text: text.clone() }).collect();
            let body = serde_json::to_vec(&entries).map_err(|e| StorageError::Io(e.to_string()))?;
            if self.batch_req("/sync/write", "POST", Some(Payload::Json(body))).await?.is_none() {
                for (k, t) in chunk {
                    self.write_note(k, t).await?;
                }
            }
        }
        Ok(())
    }
}
