//! Storage in the browser's Origin Private File System, using the async handle API (main thread).
//! Layout as on disk: `<dir>/notes/<key>.yml`, `<dir>/blobs/<name>`.

use async_trait::async_trait;
use gestalts_core::storage::{Result, Storage, StorageError, check_key, note_key_from_file};
use js_sys::{Reflect, Uint8Array};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    FileSystemDirectoryHandle, FileSystemFileHandle, FileSystemGetDirectoryOptions, FileSystemGetFileOptions,
    FileSystemWritableFileStream,
};

pub fn js_err(e: JsValue) -> StorageError {
    StorageError::Io(
        e.dyn_ref::<js_sys::Error>().map(|e| String::from(e.message())).or_else(|| e.as_string()).unwrap_or_else(|| format!("{e:?}")),
    )
}

fn is_not_found(e: &JsValue) -> bool {
    Reflect::get(e, &"name".into()).ok().and_then(|n| n.as_string()).is_some_and(|n| n == "NotFoundError")
}

pub struct Opfs {
    notes: FileSystemDirectoryHandle,
    blobs: FileSystemDirectoryHandle,
}

async fn subdir(parent: &FileSystemDirectoryHandle, name: &str) -> Result<FileSystemDirectoryHandle> {
    let opts = FileSystemGetDirectoryOptions::new();
    opts.set_create(true);
    let h = JsFuture::from(parent.get_directory_handle_with_options(name, &opts)).await.map_err(js_err)?;
    Ok(h.unchecked_into())
}

impl Opfs {
    /// Opens (creating) `dir`, which may be nested like `a/b`.
    pub async fn open(dir: &str) -> Result<Self> {
        let storage = web_sys::window().ok_or_else(|| StorageError::Io("no window".into()))?.navigator().storage();
        let mut d: FileSystemDirectoryHandle = JsFuture::from(storage.get_directory()).await.map_err(js_err)?.unchecked_into();
        for part in dir.split('/').filter(|p| !p.is_empty()) {
            d = subdir(&d, part).await?;
        }
        Ok(Opfs { notes: subdir(&d, "notes").await?, blobs: subdir(&d, "blobs").await? })
    }
}

async fn names(dir: &FileSystemDirectoryHandle) -> Result<Vec<String>> {
    // `keys()` is an async iterator; web-sys doesn't bind it, so drive it by hand
    let keys = Reflect::get(dir, &"keys".into()).map_err(js_err)?;
    let iter = keys.unchecked_into::<js_sys::Function>().call0(dir).map_err(js_err)?;
    let next = Reflect::get(&iter, &"next".into()).map_err(js_err)?.unchecked_into::<js_sys::Function>();
    let mut out = Vec::new();
    loop {
        let step = JsFuture::from(next.call0(&iter).map_err(js_err)?.unchecked_into::<js_sys::Promise>()).await.map_err(js_err)?;
        if Reflect::get(&step, &"done".into()).map_err(js_err)?.is_truthy() {
            break;
        }
        if let Some(name) = Reflect::get(&step, &"value".into()).map_err(js_err)?.as_string()
            && !name.starts_with('.')
        {
            out.push(name);
        }
    }
    out.sort();
    Ok(out)
}

async fn file(dir: &FileSystemDirectoryHandle, name: &str, create: bool) -> Result<Option<FileSystemFileHandle>> {
    let opts = FileSystemGetFileOptions::new();
    opts.set_create(create);
    match JsFuture::from(dir.get_file_handle_with_options(name, &opts)).await {
        Ok(h) => Ok(Some(h.unchecked_into())),
        Err(e) if is_not_found(&e) || Reflect::get(&e, &"name".into()).ok().and_then(|n| n.as_string()).as_deref() == Some("TypeMismatchError") => Ok(None),
        Err(e) => Err(js_err(e)),
    }
}

async fn read(dir: &FileSystemDirectoryHandle, name: &str) -> Result<Option<Vec<u8>>> {
    let Some(h) = file(dir, name, false).await? else { return Ok(None) };
    let f: web_sys::File = JsFuture::from(h.get_file()).await.map_err(js_err)?.unchecked_into();
    let buf = JsFuture::from(f.array_buffer()).await.map_err(js_err)?;
    Ok(Some(Uint8Array::new(&buf).to_vec()))
}

async fn write(dir: &FileSystemDirectoryHandle, name: &str, bytes: &[u8]) -> Result<()> {
    let h = file(dir, name, true).await?.ok_or_else(|| StorageError::Io(format!("cannot create {name}")))?;
    let w: FileSystemWritableFileStream = JsFuture::from(h.create_writable()).await.map_err(js_err)?.unchecked_into();
    // createWritable writes to a swap file; nothing is visible until close()
    JsFuture::from(w.write_with_u8_array(bytes).map_err(js_err)?).await.map_err(js_err)?;
    JsFuture::from(w.close()).await.map_err(js_err)?;
    Ok(())
}

async fn remove(dir: &FileSystemDirectoryHandle, name: &str) -> Result<()> {
    match JsFuture::from(dir.remove_entry(name)).await {
        Err(e) if !is_not_found(&e) => Err(js_err(e)),
        _ => Ok(()),
    }
}

#[async_trait(?Send)]
impl Storage for Opfs {
    async fn list_notes(&self) -> Result<Vec<String>> {
        Ok(names(&self.notes).await?.iter().filter_map(|f| note_key_from_file(f)).map(str::to_owned).collect())
    }
    async fn read_note(&self, key: &str) -> Result<Option<String>> {
        check_key(key)?;
        Ok(read(&self.notes, &format!("{key}.yml")).await?.map(|b| String::from_utf8_lossy(&b).into_owned()))
    }
    async fn write_note(&self, key: &str, text: &str) -> Result<()> {
        check_key(key)?;
        write(&self.notes, &format!("{key}.yml"), text.as_bytes()).await
    }
    async fn delete_note(&self, key: &str) -> Result<()> {
        check_key(key)?;
        remove(&self.notes, &format!("{key}.yml")).await
    }
    async fn list_blobs(&self) -> Result<Vec<String>> {
        names(&self.blobs).await
    }
    async fn read_blob(&self, name: &str) -> Result<Option<Vec<u8>>> {
        check_key(name)?;
        read(&self.blobs, name).await
    }
    async fn write_blob(&self, name: &str, bytes: &[u8]) -> Result<()> {
        check_key(name)?;
        write(&self.blobs, name, bytes).await
    }
    async fn delete_blob(&self, name: &str) -> Result<()> {
        check_key(name)?;
        remove(&self.blobs, name).await
    }
    async fn read_all_notes(&self) -> Result<Vec<(String, String)>> {
        let keys = self.list_notes().await?;
        let texts = futures::future::try_join_all(keys.iter().map(|k| self.read_note(k))).await?;
        Ok(keys.into_iter().zip(texts).filter_map(|(k, t)| Some((k, t?))).collect())
    }
}
