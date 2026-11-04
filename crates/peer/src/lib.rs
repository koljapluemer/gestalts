//! Storage over HTTP: [`Peer`], another device's node, and [`Static`], a published deck. Compiles for the browser
//! (`fetch`) and natively (reqwest, which needs a tokio runtime).

mod fetch;

use async_trait::async_trait;
use gestalts_core::storage::{Result, Storage, StorageError, check_key};
use serde::Deserialize;

use crate::fetch::{enc, fetch, json};

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
}

#[derive(Deserialize)]
struct NoteEntry {
    key: String,
    text: String,
}

impl Peer {
    pub fn new(base: &str) -> Self {
        Peer { base: base.trim_end_matches('/').to_owned() }
    }

    /// Asks the node to collect the folder's unreferenced blobs; the names it deleted. An older node
    /// without the endpoint collects nothing.
    pub async fn collect_blobs(&self) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct Collected {
            deleted: Vec<String>,
        }
        match fetch(&format!("{}/blobs/collect", self.base), "POST", Some(&[])).await {
            Ok(Some(r)) => Ok(json::<Collected>(r).await.map(|c| c.deleted).unwrap_or_default()),
            _ => Ok(vec![]),
        }
    }

    /// Fails unless a node answers at the URL.
    pub async fn health(&self) -> Result<serde_json::Value> {
        let r = fetch(&format!("{}/health", self.base), "GET", None).await?.ok_or_else(|| StorageError::Io("no node there".into()))?;
        json(r).await
    }
}

#[async_trait(?Send)]
impl Storage for Peer {
    async fn list_notes(&self) -> Result<Vec<String>> {
        Ok(self.read_all_notes().await?.into_iter().map(|(k, _)| k).collect())
    }
    async fn read_note(&self, key: &str) -> Result<Option<String>> {
        match fetch(&format!("{}/notes/{}", self.base, enc(key)), "GET", None).await? {
            Some(r) => Ok(Some(r.text().await?)),
            None => Ok(None),
        }
    }
    async fn write_note(&self, key: &str, text: &str) -> Result<()> {
        fetch(&format!("{}/notes/{}", self.base, enc(key)), "PUT", Some(text.as_bytes())).await.map(drop)
    }
    async fn delete_note(&self, key: &str) -> Result<()> {
        fetch(&format!("{}/notes/{}", self.base, enc(key)), "DELETE", None).await.map(drop)
    }
    async fn list_blobs(&self) -> Result<Vec<String>> {
        match fetch(&format!("{}/blobs", self.base), "GET", None).await? {
            Some(r) => json(r).await,
            None => Ok(vec![]),
        }
    }
    async fn read_blob(&self, name: &str) -> Result<Option<Vec<u8>>> {
        match fetch(&format!("{}/blobs/{}", self.base, enc(name)), "GET", None).await? {
            Some(r) => Ok(Some(r.bytes().await?)),
            None => Ok(None),
        }
    }
    async fn write_blob(&self, name: &str, data: &[u8]) -> Result<()> {
        fetch(&format!("{}/blobs/{}", self.base, enc(name)), "PUT", Some(data)).await.map(drop)
    }
    async fn delete_blob(&self, name: &str) -> Result<()> {
        fetch(&format!("{}/blobs/{}", self.base, enc(name)), "DELETE", None).await.map(drop)
    }
    async fn read_all_notes(&self) -> Result<Vec<(String, String)>> {
        let r = fetch(&format!("{}/notes", self.base), "GET", None).await?.ok_or_else(|| StorageError::Io("no /notes".into()))?;
        let entries: Vec<NoteEntry> = json(r).await?;
        Ok(entries.into_iter().map(|e| (e.key, e.text)).collect())
    }
}
