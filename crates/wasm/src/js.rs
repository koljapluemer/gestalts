//! `Storage` over an object the page provides, e.g. a native app's folder reached over IPC (`@gestalts/client`'s
//! Tauri backend). Every method is async on the JS side; the batch ones keep opening and syncing to a few calls.

use async_trait::async_trait;
use gestalts_core::storage::{Hashes, Result, Storage, StorageError};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[wasm_bindgen(typescript_custom_section)]
const TS: &'static str = r#"
/** Notes and blobs somewhere the page can't reach itself (a native app's folder). Keys and names as in `Storage`. */
export interface HostStorage {
  listNotes(): Promise<string[]>;
  readNote(key: string): Promise<string | null>;
  /** the given notes that exist, as `[key, text]` */
  readNotes(keys: string[]): Promise<[string, string][]>;
  readAllNotes(): Promise<[string, string][]>;
  /** `{key: content hash}` of every note */
  noteHashes(): Promise<Record<string, string>>;
  writeNote(key: string, text: string): Promise<void>;
  writeNotes(notes: [string, string][]): Promise<void>;
  deleteNote(key: string): Promise<void>;
  listBlobs(): Promise<string[]>;
  readBlob(name: string): Promise<Uint8Array | null>;
  writeBlob(name: string, bytes: Uint8Array): Promise<void>;
  deleteBlob(name: string): Promise<void>;
}
"#;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "HostStorage")]
    pub type HostStorage;

    #[wasm_bindgen(method, catch, js_name = listNotes)]
    fn list_notes(this: &HostStorage) -> std::result::Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(method, catch, js_name = readNote)]
    fn read_note(this: &HostStorage, key: &str) -> std::result::Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(method, catch, js_name = readNotes)]
    fn read_notes(this: &HostStorage, keys: Vec<String>) -> std::result::Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(method, catch, js_name = readAllNotes)]
    fn read_all_notes(this: &HostStorage) -> std::result::Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(method, catch, js_name = noteHashes)]
    fn note_hashes(this: &HostStorage) -> std::result::Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(method, catch, js_name = writeNote)]
    fn write_note(this: &HostStorage, key: &str, text: &str) -> std::result::Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(method, catch, js_name = writeNotes)]
    fn write_notes(this: &HostStorage, notes: JsValue) -> std::result::Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(method, catch, js_name = deleteNote)]
    fn delete_note(this: &HostStorage, key: &str) -> std::result::Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(method, catch, js_name = listBlobs)]
    fn list_blobs(this: &HostStorage) -> std::result::Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(method, catch, js_name = readBlob)]
    fn read_blob(this: &HostStorage, name: &str) -> std::result::Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(method, catch, js_name = writeBlob)]
    fn write_blob(this: &HostStorage, name: &str, bytes: &[u8]) -> std::result::Result<js_sys::Promise, JsValue>;
    #[wasm_bindgen(method, catch, js_name = deleteBlob)]
    fn delete_blob(this: &HostStorage, name: &str) -> std::result::Result<js_sys::Promise, JsValue>;
}

/// The page's [`HostStorage`] as a core `Storage`.
pub struct JsStorage(HostStorage);

impl JsStorage {
    pub fn new(host: HostStorage) -> Self {
        JsStorage(host)
    }
}

fn io(e: JsValue) -> StorageError {
    // the host rejects with an Error, a string (Tauri's command errors) or anything else
    let msg = e
        .dyn_ref::<js_sys::Error>()
        .map(|e| String::from(e.message()))
        .or_else(|| e.as_string())
        .unwrap_or_else(|| format!("{e:?}"));
    StorageError::Io(msg)
}

async fn call(p: std::result::Result<js_sys::Promise, JsValue>) -> Result<JsValue> {
    JsFuture::from(p.map_err(io)?).await.map_err(io)
}

fn decode<T: serde::de::DeserializeOwned>(v: JsValue) -> Result<T> {
    serde_wasm_bindgen::from_value(v).map_err(|e| StorageError::Io(e.to_string()))
}

fn encode<T: serde::Serialize>(v: &T) -> Result<JsValue> {
    v.serialize(&serde_wasm_bindgen::Serializer::json_compatible()).map_err(|e| StorageError::Io(e.to_string()))
}

#[async_trait(?Send)]
impl Storage for JsStorage {
    async fn list_notes(&self) -> Result<Vec<String>> {
        decode(call(self.0.list_notes()).await?)
    }
    async fn read_note(&self, key: &str) -> Result<Option<String>> {
        Ok(call(self.0.read_note(key)).await?.as_string())
    }
    async fn write_note(&self, key: &str, text: &str) -> Result<()> {
        call(self.0.write_note(key, text)).await.map(drop)
    }
    async fn delete_note(&self, key: &str) -> Result<()> {
        call(self.0.delete_note(key)).await.map(drop)
    }
    async fn list_blobs(&self) -> Result<Vec<String>> {
        decode(call(self.0.list_blobs()).await?)
    }
    async fn read_blob(&self, name: &str) -> Result<Option<Vec<u8>>> {
        let v = call(self.0.read_blob(name)).await?;
        if v.is_null() || v.is_undefined() {
            return Ok(None);
        }
        Ok(Some(js_sys::Uint8Array::new(&v).to_vec()))
    }
    async fn write_blob(&self, name: &str, bytes: &[u8]) -> Result<()> {
        call(self.0.write_blob(name, bytes)).await.map(drop)
    }
    async fn delete_blob(&self, name: &str) -> Result<()> {
        call(self.0.delete_blob(name)).await.map(drop)
    }
    async fn read_all_notes(&self) -> Result<Vec<(String, String)>> {
        decode(call(self.0.read_all_notes()).await?)
    }
    async fn note_hashes(&self) -> Result<Hashes> {
        decode(call(self.0.note_hashes()).await?)
    }
    async fn read_notes(&self, keys: &[String]) -> Result<Vec<(String, String)>> {
        if keys.is_empty() {
            return Ok(vec![]);
        }
        decode(call(self.0.read_notes(keys.to_vec())).await?)
    }
    async fn write_notes(&self, notes: &[(String, String)]) -> Result<()> {
        if notes.is_empty() {
            return Ok(());
        }
        call(self.0.write_notes(encode(&notes)?)).await.map(drop)
    }
}
