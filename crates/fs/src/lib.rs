//! Storage adapter for a folder on disk: `<root>/notes/<id>.yml`, `<root>/blobs/<name>`.

use std::collections::HashMap;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use async_trait::async_trait;
use gestalts_core::content_hash;
use gestalts_core::storage::{Hashes, Result, Storage, StorageError, check_key, yml_id_from_file};

mod publish;
pub use publish::{PublishReport, blob_name, publish};

type HashCache = HashMap<String, (SystemTime, u64, String)>;

#[derive(Debug, Clone)]
pub struct FsStorage {
    root: PathBuf,
    /// by file: its hash, as of a modification time and size
    hashes: Arc<Mutex<HashCache>>,
}

fn io(e: std::io::Error) -> StorageError {
    StorageError::Io(e.to_string())
}

/// `Ok(None)` for a missing file.
fn read_opt(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io(e)),
    }
}

/// Writes via a temp file and rename, so readers never see half a file; unchanged content is not rewritten.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if read_opt(path)?.as_deref() == Some(bytes) {
        return Ok(());
    }
    let dir = path.parent().expect("paths have a parent");
    fs::create_dir_all(dir).map_err(io)?;
    let tmp = dir.join(format!(".{}.tmp", path.file_name().unwrap().to_string_lossy()));
    let mut f = fs::File::create(&tmp).map_err(io)?;
    f.write_all(bytes).map_err(io)?;
    f.sync_all().map_err(io)?;
    fs::rename(&tmp, path).map_err(io)
}

fn list(dir: &Path) -> Result<Vec<String>> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(io(e)),
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| !n.starts_with('.'))
        .collect();
    names.sort();
    Ok(names)
}

/// Synchronous versions of the [`Storage`] methods, for servers that need `Send` futures.
impl FsStorage {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        FsStorage { root: root.into(), hashes: Arc::default() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn note_path(&self, key: &str) -> Result<PathBuf> {
        check_key(key)?;
        Ok(self.root.join("notes").join(format!("{key}.yml")))
    }

    fn blob_path(&self, name: &str) -> Result<PathBuf> {
        check_key(name)?;
        Ok(self.root.join("blobs").join(name))
    }

    pub fn list_ymls_sync(&self) -> Result<Vec<String>> {
        Ok(list(&self.root.join("notes"))?.iter().filter_map(|f| yml_id_from_file(f)).map(str::to_owned).collect())
    }

    pub fn read_yml_sync(&self, key: &str) -> Result<Option<String>> {
        Ok(read_opt(&self.note_path(key)?)?.map(|b| String::from_utf8_lossy(&b).into_owned()))
    }

    /// Every yml's content hash, reading only the files that changed since last asked.
    pub fn yml_hashes_sync(&self) -> Result<Hashes> {
        let dir = self.root.join("notes");
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Hashes::new()),
            Err(e) => return Err(io(e)),
        };
        let mut cache = self.hashes.lock().expect("hash cache lock");
        let mut out = Hashes::new();
        let mut fresh = HashMap::new();
        for entry in entries.flatten() {
            let (Ok(name), Ok(meta)) = (entry.file_name().into_string(), entry.metadata()) else { continue };
            if !meta.is_file() || name.starts_with('.') {
                continue;
            }
            let Some(id) = yml_id_from_file(&name) else { continue };
            let modified = meta.modified().map_err(io)?;
            let hash = match cache.get(id) {
                Some((m, len, h)) if *m == modified && *len == meta.len() => h.clone(),
                _ => match read_opt(&entry.path())? {
                    Some(bytes) => content_hash(String::from_utf8_lossy(&bytes).as_bytes()),
                    None => continue,
                },
            };
            fresh.insert(id.to_owned(), (modified, meta.len(), hash.clone()));
            out.insert(id.to_owned(), hash);
        }
        *cache = fresh;
        Ok(out)
    }

    pub fn write_yml_sync(&self, key: &str, text: &str) -> Result<()> {
        write_atomic(&self.note_path(key)?, text.as_bytes())
    }

    pub fn delete_yml_sync(&self, key: &str) -> Result<()> {
        match fs::remove_file(self.note_path(key)?) {
            Err(e) if e.kind() != ErrorKind::NotFound => Err(io(e)),
            _ => Ok(()),
        }
    }

    pub fn list_blobs_sync(&self) -> Result<Vec<String>> {
        list(&self.root.join("blobs"))
    }

    pub fn read_blob_sync(&self, name: &str) -> Result<Option<Vec<u8>>> {
        read_opt(&self.blob_path(name)?)
    }

    pub fn write_blob_sync(&self, name: &str, bytes: &[u8]) -> Result<()> {
        write_atomic(&self.blob_path(name)?, bytes)
    }

    pub fn delete_blob_sync(&self, name: &str) -> Result<()> {
        match fs::remove_file(self.blob_path(name)?) {
            Err(e) if e.kind() != ErrorKind::NotFound => Err(io(e)),
            _ => Ok(()),
        }
    }
}

#[async_trait(?Send)]
impl Storage for FsStorage {
    async fn list_ymls(&self) -> Result<Vec<String>> {
        self.list_ymls_sync()
    }
    async fn read_yml(&self, key: &str) -> Result<Option<String>> {
        self.read_yml_sync(key)
    }
    async fn write_yml(&self, key: &str, text: &str) -> Result<()> {
        self.write_yml_sync(key, text)
    }
    async fn yml_hashes(&self) -> Result<Hashes> {
        self.yml_hashes_sync()
    }
    async fn delete_yml(&self, key: &str) -> Result<()> {
        self.delete_yml_sync(key)
    }
    async fn list_blobs(&self) -> Result<Vec<String>> {
        self.list_blobs_sync()
    }
    async fn read_blob(&self, name: &str) -> Result<Option<Vec<u8>>> {
        self.read_blob_sync(name)
    }
    async fn write_blob(&self, name: &str, bytes: &[u8]) -> Result<()> {
        self.write_blob_sync(name, bytes)
    }
    async fn delete_blob(&self, name: &str) -> Result<()> {
        self.delete_blob_sync(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let dir = std::env::temp_dir().join(format!("gestalts-fs-test-{}", std::process::id()));
        let s = FsStorage::new(&dir);
        assert!(s.list_ymls_sync().unwrap().is_empty());
        s.write_yml_sync("a", "x: 1").unwrap();
        s.write_blob_sync("b.bin", &[1, 2]).unwrap();
        fs::write(dir.join("notes/readme.txt"), "ignored").unwrap();
        assert_eq!(s.list_ymls_sync().unwrap(), vec!["a"]);
        assert_eq!(s.read_yml_sync("a").unwrap().as_deref(), Some("x: 1"));
        assert_eq!(s.read_yml_sync("missing").unwrap(), None);
        assert_eq!(s.list_blobs_sync().unwrap(), vec!["b.bin"]);
        assert!(s.write_yml_sync("../escape", "x").is_err());
        s.delete_yml_sync("a").unwrap();
        s.delete_yml_sync("a").unwrap();
        assert!(s.list_ymls_sync().unwrap().is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn hashes_read_only_what_changed() {
        let dir = std::env::temp_dir().join(format!("gestalts-fs-hash-test-{}", std::process::id()));
        let s = FsStorage::new(&dir);
        s.write_yml_sync("a", "one").unwrap();
        s.write_yml_sync("b", "x").unwrap();
        let first = s.yml_hashes_sync().unwrap();
        assert_eq!(first["a"], content_hash(b"one"));
        // same size and time: answered from the cache, proving the file wasn't read
        let path = dir.join("notes/a.yml");
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        fs::write(&path, "two").unwrap();
        fs::File::options().write(true).open(&path).unwrap().set_modified(modified).unwrap();
        assert_eq!(s.yml_hashes_sync().unwrap()["a"], content_hash(b"one"));
        // a real edit is seen, and a removed file is gone
        s.write_yml_sync("a", "changed").unwrap();
        s.delete_yml_sync("b").unwrap();
        let h = s.yml_hashes_sync().unwrap();
        assert_eq!(h["a"], content_hash(b"changed"));
        assert!(!h.contains_key("b"));
        fs::remove_dir_all(&dir).unwrap();
    }
}
