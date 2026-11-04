//! Storage over `fetch`: a read-only static site, and the desktop connector.

use async_trait::async_trait;
use gestalts_core::storage::{Result, Storage, StorageError, check_key};
use js_sys::{Uint8Array, encode_uri_component};
use serde::Deserialize;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use web_sys::{Request, RequestInit, Response};

use crate::opfs::js_err;

fn enc(s: &str) -> String {
    encode_uri_component(s).into()
}

/// `Ok(None)` on 404.
async fn fetch(url: &str, method: &str, body: Option<&[u8]>) -> Result<Option<Response>> {
    let init = RequestInit::new();
    init.set_method(method);
    if let Some(b) = body {
        init.set_body(&Uint8Array::from(b).into());
    }
    let req = Request::new_with_str_and_init(url, &init).map_err(js_err)?;
    let window = web_sys::window().ok_or_else(|| StorageError::Io("no window".into()))?;
    let resp: Response = JsFuture::from(window.fetch_with_request(&req))
        .await
        .map_err(|e| StorageError::Io(format!("{method} {url}: {}", js_err(e))))?
        .unchecked_into();
    match resp.status() {
        404 => Ok(None),
        s if (200..300).contains(&s) => Ok(Some(resp)),
        s => {
            let text = JsFuture::from(resp.text().map_err(js_err)?).await.ok().and_then(|t| t.as_string()).unwrap_or_default();
            Err(StorageError::Io(format!("{method} {url}: {s} {text}")))
        }
    }
}

async fn text(resp: Response) -> Result<String> {
    Ok(JsFuture::from(resp.text().map_err(js_err)?).await.map_err(js_err)?.as_string().unwrap_or_default())
}

async fn bytes(resp: Response) -> Result<Vec<u8>> {
    let buf = JsFuture::from(resp.array_buffer().map_err(js_err)?).await.map_err(js_err)?;
    Ok(Uint8Array::new(&buf).to_vec())
}

async fn json<T: for<'de> Deserialize<'de>>(resp: Response) -> Result<T> {
    serde_json::from_str(&text(resp).await?).map_err(|e| StorageError::Io(e.to_string()))
}

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
        match fetch(&format!("{}/notes/{}.yml", self.base, enc(key)), "GET", None).await? {
            Some(r) => Ok(Some(text(r).await?)),
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
            Some(r) => Ok(Some(bytes(r).await?)),
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

/// The desktop connector (`gestalts-connector`), see `doc/node.md`.
pub struct Connector {
    base: String,
}

#[derive(Deserialize)]
struct NoteEntry {
    key: String,
    text: String,
}

impl Connector {
    pub fn new(base: &str) -> Self {
        Connector { base: base.trim_end_matches('/').to_owned() }
    }

    /// Asks the connector to collect the folder's unreferenced blobs; the names it deleted. An older connector
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

    /// Fails unless a connector answers at the URL.
    pub async fn health(&self) -> Result<serde_json::Value> {
        let r = fetch(&format!("{}/health", self.base), "GET", None).await?.ok_or_else(|| StorageError::Io("no connector there".into()))?;
        json(r).await
    }
}

#[async_trait(?Send)]
impl Storage for Connector {
    async fn list_notes(&self) -> Result<Vec<String>> {
        Ok(self.read_all_notes().await?.into_iter().map(|(k, _)| k).collect())
    }
    async fn read_note(&self, key: &str) -> Result<Option<String>> {
        match fetch(&format!("{}/notes/{}", self.base, enc(key)), "GET", None).await? {
            Some(r) => Ok(Some(text(r).await?)),
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
            Some(r) => Ok(Some(bytes(r).await?)),
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
