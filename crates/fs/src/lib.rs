//! Storage adapter for a folder on disk: `<root>/notes/<key>.yml`, `<root>/blobs/<name>`.

use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use gestalts_core::storage::{Result, Storage, StorageError, check_key, note_key_from_file};

mod publish;
pub use publish::{PublishReport, blob_name, publish};

#[derive(Debug, Clone)]
pub struct FsStorage {
    root: PathBuf,
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
        FsStorage { root: root.into() }
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

    pub fn list_notes_sync(&self) -> Result<Vec<String>> {
        Ok(list(&self.root.join("notes"))?.iter().filter_map(|f| note_key_from_file(f)).map(str::to_owned).collect())
    }

    pub fn read_note_sync(&self, key: &str) -> Result<Option<String>> {
        Ok(read_opt(&self.note_path(key)?)?.map(|b| String::from_utf8_lossy(&b).into_owned()))
    }

    pub fn write_note_sync(&self, key: &str, text: &str) -> Result<()> {
        write_atomic(&self.note_path(key)?, text.as_bytes())
    }

    pub fn delete_note_sync(&self, key: &str) -> Result<()> {
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
    async fn list_notes(&self) -> Result<Vec<String>> {
        self.list_notes_sync()
    }
    async fn read_note(&self, key: &str) -> Result<Option<String>> {
        self.read_note_sync(key)
    }
    async fn write_note(&self, key: &str, text: &str) -> Result<()> {
        self.write_note_sync(key, text)
    }
    async fn delete_note(&self, key: &str) -> Result<()> {
        self.delete_note_sync(key)
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
        assert!(s.list_notes_sync().unwrap().is_empty());
        s.write_note_sync("a", "x: 1").unwrap();
        s.write_blob_sync("b.bin", &[1, 2]).unwrap();
        fs::write(dir.join("notes/readme.txt"), "ignored").unwrap();
        assert_eq!(s.list_notes_sync().unwrap(), vec!["a"]);
        assert_eq!(s.read_note_sync("a").unwrap().as_deref(), Some("x: 1"));
        assert_eq!(s.read_note_sync("missing").unwrap(), None);
        assert_eq!(s.list_blobs_sync().unwrap(), vec!["b.bin"]);
        assert!(s.write_note_sync("../escape", "x").is_err());
        s.delete_note_sync("a").unwrap();
        s.delete_note_sync("a").unwrap();
        assert!(s.list_notes_sync().unwrap().is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }
}
