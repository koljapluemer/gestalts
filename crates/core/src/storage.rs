//! The storage port. Adapters: a folder on disk (`fs`), OPFS (`wasm`), a static site and another device's node over
//! HTTP (`peer`).

use std::cell::RefCell;
use std::collections::BTreeMap;

use async_trait::async_trait;

use crate::yml::{content_hash, valid_key};

/// `{key: content hash}` of notes (see [`content_hash`]).
pub type Hashes = BTreeMap<String, String>;

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("invalid key or blob name: {0:?}")]
    InvalidKey(String),
    #[error("storage is read-only")]
    ReadOnly,
    #[error("rejected: {0}")]
    Rejected(String),
    #[error("{0}")]
    Io(String),
}

pub type Result<T> = std::result::Result<T, StorageError>;

/// Raw note text and blob bytes, addressed by key (`notes/<key>.yml`) and name (`blobs/<name>`).
/// Not `Send`: the browser adapters live on the main thread.
#[async_trait(?Send)]
pub trait Storage {
    async fn list_ymls(&self) -> Result<Vec<String>>;
    async fn read_yml(&self, key: &str) -> Result<Option<String>>;
    async fn write_yml(&self, key: &str, text: &str) -> Result<()>;
    /// deleting a missing note is not an error
    async fn delete_yml(&self, key: &str) -> Result<()>;
    async fn list_blobs(&self) -> Result<Vec<String>>;
    async fn read_blob(&self, name: &str) -> Result<Option<Vec<u8>>>;
    async fn write_blob(&self, name: &str, bytes: &[u8]) -> Result<()>;
    /// deleting a missing blob is not an error
    async fn delete_blob(&self, name: &str) -> Result<()>;

    /// Every note at once; adapters with a bulk endpoint override this.
    async fn read_all_ymls(&self) -> Result<Vec<(String, String)>> {
        let mut out = Vec::new();
        for key in self.list_ymls().await? {
            if let Some(text) = self.read_yml(&key).await? {
                out.push((key, text));
            }
        }
        Ok(out)
    }

    /// Every note's content hash; adapters that can answer without sending every text override this.
    async fn yml_hashes(&self) -> Result<Hashes> {
        Ok(self.read_all_ymls().await?.into_iter().map(|(k, t)| (k, content_hash(t.as_bytes()))).collect())
    }

    /// The given notes that exist; adapters with a bulk endpoint override this.
    async fn read_ymls(&self, keys: &[String]) -> Result<Vec<(String, String)>> {
        let mut out = Vec::new();
        for key in keys {
            if let Some(text) = self.read_yml(key).await? {
                out.push((key.clone(), text));
            }
        }
        Ok(out)
    }

    /// Writes several notes; adapters with a bulk endpoint override this.
    async fn write_ymls(&self, notes: &[(String, String)]) -> Result<()> {
        for (key, text) in notes {
            self.write_yml(key, text).await?;
        }
        Ok(())
    }
}

pub fn check_key(key: &str) -> Result<()> {
    if valid_key(key) { Ok(()) } else { Err(StorageError::InvalidKey(key.to_owned())) }
}

/// Strips `.yml` from a file name in `notes/`; other files there are ignored.
pub fn yml_id_from_file(file: &str) -> Option<&str> {
    file.strip_suffix(".yml").filter(|k| valid_key(k))
}

/// A read-only deck under a [`Layered`] storage: its `source` id (`<plugin>/<deck>`) and its notes.
pub struct Deck<B> {
    pub source: String,
    pub storage: B,
}

/// Reads from `top`, falling back to the read-only decks; writes go to `top` only. A tombstone in `top` hides the deck
/// yml under it. An id several decks hold is the merge of their texts ([`crate::decks::Decks`]).
pub struct Layered<B, T> {
    pub decks: Vec<Deck<B>>,
    pub top: T,
    pub gestalts: crate::Gestalts,
    /// what the decks disagreed on when last read in full, as `key: path`
    pub deck_conflicts: std::cell::RefCell<Vec<String>>,
}

impl<B: Storage, T> Layered<B, T> {
    pub fn new(decks: Vec<Deck<B>>, top: T, gestalts: crate::Gestalts) -> Self {
        Layered { decks, top, gestalts, deck_conflicts: Default::default() }
    }

    pub fn deck_refs(&self) -> crate::decks::Decks<'_> {
        crate::decks::Decks {
            decks: self.decks.iter().map(|d| crate::decks::DeckRef { source: &d.source, storage: &d.storage as &dyn Storage }).collect(),
            gestalts: &self.gestalts,
        }
    }
}

#[async_trait(?Send)]
impl<B: Storage, T: Storage> Storage for Layered<B, T> {
    async fn list_ymls(&self) -> Result<Vec<String>> {
        let mut all = self.top.list_ymls().await?;
        for d in &self.decks {
            all = union(all, d.storage.list_ymls().await?);
        }
        Ok(all)
    }
    async fn read_yml(&self, key: &str) -> Result<Option<String>> {
        if let Some(t) = self.top.read_yml(key).await? {
            return Ok(Some(t));
        }
        Ok(self.deck_refs().read(key).await?.map(|m| m.text))
    }
    async fn write_yml(&self, key: &str, text: &str) -> Result<()> {
        self.top.write_yml(key, text).await
    }
    async fn delete_yml(&self, key: &str) -> Result<()> {
        if self.top.read_yml(key).await?.is_none() {
            for d in &self.decks {
                if d.storage.read_yml(key).await?.is_some() {
                    return Err(StorageError::ReadOnly);
                }
            }
        }
        self.top.delete_yml(key).await
    }
    async fn list_blobs(&self) -> Result<Vec<String>> {
        let mut all = self.top.list_blobs().await?;
        for d in &self.decks {
            all = union(all, d.storage.list_blobs().await?);
        }
        Ok(all)
    }
    async fn read_blob(&self, name: &str) -> Result<Option<Vec<u8>>> {
        if let Some(b) = self.top.read_blob(name).await? {
            return Ok(Some(b));
        }
        for d in &self.decks {
            if let Some(b) = d.storage.read_blob(name).await? {
                return Ok(Some(b));
            }
        }
        Ok(None)
    }
    async fn write_blob(&self, name: &str, bytes: &[u8]) -> Result<()> {
        self.top.write_blob(name, bytes).await
    }
    /// From `top` only: decks are never collected.
    async fn delete_blob(&self, name: &str) -> Result<()> {
        self.top.delete_blob(name).await
    }
    async fn read_all_ymls(&self) -> Result<Vec<(String, String)>> {
        let mut out = self.top.read_all_ymls().await?;
        let seen: std::collections::HashSet<String> = out.iter().map(|(k, _)| k.clone()).collect();
        let mut conflicts = Vec::new();
        for (k, m) in self.deck_refs().read_all().await? {
            conflicts.extend(m.conflicts);
            if !seen.contains(&k) {
                out.push((k, m.text));
            }
        }
        *self.deck_conflicts.borrow_mut() = conflicts;
        Ok(out)
    }
}

fn union(mut a: Vec<String>, b: Vec<String>) -> Vec<String> {
    for k in b {
        if !a.contains(&k) {
            a.push(k);
        }
    }
    a
}

/// In-memory storage, for tests and as a sync base snapshot where nothing persists.
#[derive(Default)]
pub struct Memory {
    notes: std::cell::RefCell<std::collections::BTreeMap<String, String>>,
    blobs: std::cell::RefCell<std::collections::BTreeMap<String, Vec<u8>>>,
}

#[async_trait(?Send)]
impl Storage for Memory {
    async fn list_ymls(&self) -> Result<Vec<String>> {
        Ok(self.notes.borrow().keys().cloned().collect())
    }
    async fn read_yml(&self, key: &str) -> Result<Option<String>> {
        Ok(self.notes.borrow().get(key).cloned())
    }
    async fn write_yml(&self, key: &str, text: &str) -> Result<()> {
        check_key(key)?;
        self.notes.borrow_mut().insert(key.into(), text.into());
        Ok(())
    }
    async fn delete_yml(&self, key: &str) -> Result<()> {
        self.notes.borrow_mut().remove(key);
        Ok(())
    }
    async fn list_blobs(&self) -> Result<Vec<String>> {
        Ok(self.blobs.borrow().keys().cloned().collect())
    }
    async fn read_blob(&self, name: &str) -> Result<Option<Vec<u8>>> {
        Ok(self.blobs.borrow().get(name).cloned())
    }
    async fn write_blob(&self, name: &str, bytes: &[u8]) -> Result<()> {
        check_key(name)?;
        self.blobs.borrow_mut().insert(name.into(), bytes.into());
        Ok(())
    }
    async fn delete_blob(&self, name: &str) -> Result<()> {
        self.blobs.borrow_mut().remove(name);
        Ok(())
    }
}

macro_rules! forward_storage {
    ($ty:ty) => {
        #[async_trait(?Send)]
        impl<S: Storage + ?Sized> Storage for $ty {
            async fn list_ymls(&self) -> Result<Vec<String>> { (**self).list_ymls().await }
            async fn read_yml(&self, key: &str) -> Result<Option<String>> { (**self).read_yml(key).await }
            async fn write_yml(&self, key: &str, text: &str) -> Result<()> { (**self).write_yml(key, text).await }
            async fn delete_yml(&self, key: &str) -> Result<()> { (**self).delete_yml(key).await }
            async fn list_blobs(&self) -> Result<Vec<String>> { (**self).list_blobs().await }
            async fn read_blob(&self, name: &str) -> Result<Option<Vec<u8>>> { (**self).read_blob(name).await }
            async fn write_blob(&self, name: &str, bytes: &[u8]) -> Result<()> { (**self).write_blob(name, bytes).await }
            async fn delete_blob(&self, name: &str) -> Result<()> { (**self).delete_blob(name).await }
            async fn read_all_ymls(&self) -> Result<Vec<(String, String)>> { (**self).read_all_ymls().await }
            async fn yml_hashes(&self) -> Result<Hashes> { (**self).yml_hashes().await }
            async fn read_ymls(&self, keys: &[String]) -> Result<Vec<(String, String)>> { (**self).read_ymls(keys).await }
            async fn write_ymls(&self, notes: &[(String, String)]) -> Result<()> { (**self).write_ymls(notes).await }
        }
    };
}
forward_storage!(Box<S>);
forward_storage!(std::rc::Rc<S>);
forward_storage!(&S);

/// A storage that knows the content hash of each of its notes, so a sync can tell which changed without reading them
/// ([`crate::sync`]).
///
/// It learns them as notes pass through: reading every note (which opening a repo does anyway) seeds it, and every
/// read, write and delete keeps it current. Until seeded, `yml_hashes` reads every note once.
///
/// Writes from elsewhere (another browser tab on the same OPFS) can leave a hash stale. That's safe: a sync reads the
/// real text of every note it merges or writes, so a stale hash only delays pushing that note until the tab that wrote
/// it syncs, or the page is opened again.
pub struct Tracked<S> {
    inner: S,
    hashes: RefCell<Option<Hashes>>,
}

impl<S: Storage> Tracked<S> {
    pub fn new(inner: S) -> Self {
        Tracked { inner, hashes: RefCell::new(None) }
    }

    pub fn inner(&self) -> &S {
        &self.inner
    }

    fn note(&self, key: &str, text: Option<&str>) {
        if let Some(h) = self.hashes.borrow_mut().as_mut() {
            match text {
                Some(t) => h.insert(key.to_owned(), content_hash(t.as_bytes())),
                None => h.remove(key),
            };
        }
    }
}

#[async_trait(?Send)]
impl<S: Storage> Storage for Tracked<S> {
    async fn list_ymls(&self) -> Result<Vec<String>> {
        self.inner.list_ymls().await
    }
    async fn read_yml(&self, key: &str) -> Result<Option<String>> {
        let t = self.inner.read_yml(key).await?;
        self.note(key, t.as_deref());
        Ok(t)
    }
    async fn write_yml(&self, key: &str, text: &str) -> Result<()> {
        self.inner.write_yml(key, text).await?;
        self.note(key, Some(text));
        Ok(())
    }
    async fn delete_yml(&self, key: &str) -> Result<()> {
        self.inner.delete_yml(key).await?;
        self.note(key, None);
        Ok(())
    }
    async fn list_blobs(&self) -> Result<Vec<String>> {
        self.inner.list_blobs().await
    }
    async fn read_blob(&self, name: &str) -> Result<Option<Vec<u8>>> {
        self.inner.read_blob(name).await
    }
    async fn write_blob(&self, name: &str, bytes: &[u8]) -> Result<()> {
        self.inner.write_blob(name, bytes).await
    }
    async fn delete_blob(&self, name: &str) -> Result<()> {
        self.inner.delete_blob(name).await
    }
    async fn read_all_ymls(&self) -> Result<Vec<(String, String)>> {
        let all = self.inner.read_all_ymls().await?;
        *self.hashes.borrow_mut() = Some(all.iter().map(|(k, t)| (k.clone(), content_hash(t.as_bytes()))).collect());
        Ok(all)
    }
    async fn yml_hashes(&self) -> Result<Hashes> {
        if let Some(h) = self.hashes.borrow().as_ref() {
            return Ok(h.clone());
        }
        self.read_all_ymls().await?;
        Ok(self.hashes.borrow().clone().unwrap_or_default())
    }
    async fn read_ymls(&self, keys: &[String]) -> Result<Vec<(String, String)>> {
        let found = self.inner.read_ymls(keys).await?;
        for key in keys {
            self.note(key, found.iter().find(|(k, _)| k == key).map(|(_, t)| t.as_str()));
        }
        Ok(found)
    }
    async fn write_ymls(&self, notes: &[(String, String)]) -> Result<()> {
        self.inner.write_ymls(notes).await?;
        for (k, t) in notes {
            self.note(k, Some(t));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layered() -> Layered<Memory, Memory> {
        Layered::new(vec![Deck { source: "p/demo".into(), storage: Memory::default() }], Memory::default(), crate::Gestalts::builtin())
    }

    #[test]
    fn a_write_stays_in_top_and_copies_nothing_up() {
        pollster::block_on(async {
            let l = layered();
            l.decks[0].storage.write_yml("c", "id: c\ngestalt: note@1\n").await.unwrap();
            l.write_yml("s", "id: s\ngestalt: fsrs-data@1\ntarget: c\n").await.unwrap();
            assert_eq!(l.top.list_ymls().await.unwrap(), vec!["s"]);
            assert_eq!(l.list_ymls().await.unwrap().len(), 2);
            assert!(l.read_yml("c").await.unwrap().is_some());
        });
    }

    #[test]
    fn a_tombstone_in_top_hides_the_deck_yml() {
        pollster::block_on(async {
            let l = layered();
            l.decks[0].storage.write_yml("c", "id: c\ngestalt: note@1\n").await.unwrap();
            let repo = crate::Repo::new(l, crate::Gestalts::builtin());
            repo.load().await.unwrap();
            repo.delete("c", "2026-11-04T10:00:00Z").await.unwrap();
            repo.load().await.unwrap();
            assert!(repo.get("c").is_none());
        });
    }
}
