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

/// A gestalt data folder published as static files, with an `index.json` of `{ymls: [ids], blobs: [names]}`.
pub struct Static {
    base: String,
    index: Index,
}

#[derive(Deserialize, Default)]
struct Index {
    ymls: Vec<String>,
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
    async fn list_ymls(&self) -> Result<Vec<String>> {
        Ok(self.index.ymls.clone())
    }
    async fn read_yml(&self, key: &str) -> Result<Option<String>> {
        check_key(key)?;
        // the index is complete: asking the server for anything else is a 404 per lookup
        if !self.index.ymls.iter().any(|n| n == key) {
            return Ok(None);
        }
        match fetch(&format!("{}/notes/{}.yml", self.base, enc(key)), "GET", None).await? {
            Some(r) => Ok(Some(r.text().await?)),
            None => Ok(None),
        }
    }
    async fn write_yml(&self, _: &str, _: &str) -> Result<()> {
        Err(StorageError::ReadOnly)
    }
    async fn delete_yml(&self, _: &str) -> Result<()> {
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
    async fn read_all_ymls(&self) -> Result<Vec<(String, String)>> {
        let texts = futures::future::try_join_all(self.index.ymls.iter().map(|k| self.read_yml(k))).await?;
        Ok(self.index.ymls.iter().cloned().zip(texts).filter_map(|(k, t)| Some((k, t?))).collect())
    }
}

/// Another device's node (`gestalts-node`, the desktop app's "connector"), over its node API: see `doc/node.md`.
pub struct Peer {
    base: String,
    auth: Auth,
}

#[derive(Serialize, Deserialize)]
struct YmlEntry {
    id: String,
    text: String,
}

impl Peer {
    pub fn new(base: &str) -> Self {
        Self::with_auth(base, Auth::default())
    }

    /// A node reached with `auth`: a paired node over the network (`paired.rs`).
    pub fn with_auth(base: &str, auth: Auth) -> Self {
        Peer { base: base.trim_end_matches('/').to_owned(), auth }
    }

    pub fn url(&self) -> &str {
        &self.base
    }

    async fn req(&self, path: &str, method: &str, body: Option<Payload<'_>>) -> Result<Option<Body>> {
        send(&self.auth, &format!("{}{path}", self.base), method, body).await
    }

    /// Asks the node to collect the folder's unreferenced blobs; the names it deleted.
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
    async fn list_ymls(&self) -> Result<Vec<String>> {
        Ok(self.yml_hashes().await?.into_keys().collect())
    }
    async fn read_yml(&self, key: &str) -> Result<Option<String>> {
        match self.req(&format!("/ymls/{}", enc(key)), "GET", None).await? {
            Some(r) => Ok(Some(r.text().await?)),
            None => Ok(None),
        }
    }
    async fn write_yml(&self, key: &str, text: &str) -> Result<()> {
        self.req(&format!("/ymls/{}", enc(key)), "PUT", Some(Payload::Bytes(text.as_bytes()))).await.map(drop)
    }
    async fn delete_yml(&self, key: &str) -> Result<()> {
        self.req(&format!("/ymls/{}", enc(key)), "DELETE", None).await.map(drop)
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
    async fn read_all_ymls(&self) -> Result<Vec<(String, String)>> {
        let ids: Vec<String> = self.yml_hashes().await?.into_keys().collect();
        self.read_ymls(&ids).await
    }
    async fn yml_hashes(&self) -> Result<Hashes> {
        let r = self.req("/sync/hashes", "GET", None).await?.ok_or_else(|| StorageError::Io("no folder there".into()))?;
        json(r).await
    }
    async fn read_ymls(&self, keys: &[String]) -> Result<Vec<(String, String)>> {
        let mut out = Vec::new();
        // in chunks, so a first sync of a large folder doesn't make one huge response
        for chunk in keys.chunks(500) {
            let body = serde_json::to_vec(&serde_json::json!({ "ids": chunk })).map_err(|e| StorageError::Io(e.to_string()))?;
            let r = self.req("/sync/read", "POST", Some(Payload::Json(body))).await?.ok_or_else(|| StorageError::Io("no folder there".into()))?;
            out.extend(json::<Vec<YmlEntry>>(r).await?.into_iter().map(|e| (e.id, e.text)));
        }
        Ok(out)
    }
    async fn write_ymls(&self, notes: &[(String, String)]) -> Result<()> {
        for chunk in notes.chunks(500) {
            let entries: Vec<YmlEntry> = chunk.iter().map(|(key, text)| YmlEntry { id: key.clone(), text: text.clone() }).collect();
            let body = serde_json::to_vec(&entries).map_err(|e| StorageError::Io(e.to_string()))?;
            self.req("/sync/write", "POST", Some(Payload::Json(body))).await?;
        }
        Ok(())
    }
}
