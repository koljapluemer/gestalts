//! The storage port. Adapters: a folder on disk, OPFS, a static site, the connector over HTTP.

use async_trait::async_trait;

use crate::note::valid_key;

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("invalid key or blob name: {0:?}")]
    InvalidKey(String),
    #[error("storage is read-only")]
    ReadOnly,
    #[error("{0}")]
    Io(String),
}

pub type Result<T> = std::result::Result<T, StorageError>;

/// Raw note text and blob bytes, addressed by key (`notes/<key>.yml`) and name (`blobs/<name>`).
/// Not `Send`: the browser adapters live on the main thread.
#[async_trait(?Send)]
pub trait Storage {
    async fn list_notes(&self) -> Result<Vec<String>>;
    async fn read_note(&self, key: &str) -> Result<Option<String>>;
    async fn write_note(&self, key: &str, text: &str) -> Result<()>;
    /// deleting a missing note is not an error
    async fn delete_note(&self, key: &str) -> Result<()>;
    async fn list_blobs(&self) -> Result<Vec<String>>;
    async fn read_blob(&self, name: &str) -> Result<Option<Vec<u8>>>;
    async fn write_blob(&self, name: &str, bytes: &[u8]) -> Result<()>;
    /// deleting a missing blob is not an error
    async fn delete_blob(&self, name: &str) -> Result<()>;

    /// Every note at once; adapters with a bulk endpoint override this.
    async fn read_all_notes(&self) -> Result<Vec<(String, String)>> {
        let mut out = Vec::new();
        for key in self.list_notes().await? {
            if let Some(text) = self.read_note(&key).await? {
                out.push((key, text));
            }
        }
        Ok(out)
    }
}

pub fn check_key(key: &str) -> Result<()> {
    if valid_key(key) { Ok(()) } else { Err(StorageError::InvalidKey(key.to_owned())) }
}

/// Strips `.yml` from a file name in `notes/`; other files there are ignored.
pub fn note_key_from_file(file: &str) -> Option<&str> {
    file.strip_suffix(".yml").filter(|k| valid_key(k))
}

/// A read-only deck under a [`Layered`] storage: its `source` id, earlier ids (`aliases`), and its notes.
pub struct Deck<B> {
    pub source: String,
    pub aliases: Vec<String>,
    pub storage: B,
}

/// Reads from `top`, falling back to the decks in order; writes go to `top` only.
/// Used for read-only shipped content (decks) plus the user's own notes (`top`). A tombstone in `top` hides the deck
/// note under it.
/// Copy-on-write: a note written to `top` pulls the deck notes it references into `top` (see [`crate::upstream`]),
/// tagged with their deck's `source`.
pub struct Layered<B, T> {
    pub decks: Vec<Deck<B>>,
    pub top: T,
}

impl<B: Storage, T> Layered<B, T> {
    pub fn deck_refs(&self) -> Vec<crate::upstream::DeckRef<'_>> {
        self.decks.iter().map(|d| crate::upstream::DeckRef { source: &d.source, aliases: &d.aliases, storage: &d.storage }).collect()
    }
}

#[async_trait(?Send)]
impl<B: Storage, T: Storage> Storage for Layered<B, T> {
    async fn list_notes(&self) -> Result<Vec<String>> {
        let mut all = self.top.list_notes().await?;
        for d in &self.decks {
            all = union(all, d.storage.list_notes().await?);
        }
        Ok(all)
    }
    async fn read_note(&self, key: &str) -> Result<Option<String>> {
        if let Some(t) = self.top.read_note(key).await? {
            return Ok(Some(t));
        }
        for d in &self.decks {
            if let Some(t) = d.storage.read_note(key).await? {
                return Ok(Some(t));
            }
        }
        Ok(None)
    }
    async fn write_note(&self, key: &str, text: &str) -> Result<()> {
        self.top.write_note(key, text).await?;
        crate::upstream::copy_up_refs(&self.deck_refs(), &self.top, key, text).await?;
        Ok(())
    }
    async fn delete_note(&self, key: &str) -> Result<()> {
        if self.top.read_note(key).await?.is_none() {
            for d in &self.decks {
                if d.storage.read_note(key).await?.is_some() {
                    return Err(StorageError::ReadOnly);
                }
            }
        }
        self.top.delete_note(key).await
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
    async fn read_all_notes(&self) -> Result<Vec<(String, String)>> {
        let mut out = self.top.read_all_notes().await?;
        let mut seen: std::collections::HashSet<String> = out.iter().map(|(k, _)| k.clone()).collect();
        for d in &self.decks {
            for (k, t) in d.storage.read_all_notes().await? {
                if seen.insert(k.clone()) {
                    out.push((k, t));
                }
            }
        }
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
    async fn list_notes(&self) -> Result<Vec<String>> {
        Ok(self.notes.borrow().keys().cloned().collect())
    }
    async fn read_note(&self, key: &str) -> Result<Option<String>> {
        Ok(self.notes.borrow().get(key).cloned())
    }
    async fn write_note(&self, key: &str, text: &str) -> Result<()> {
        check_key(key)?;
        self.notes.borrow_mut().insert(key.into(), text.into());
        Ok(())
    }
    async fn delete_note(&self, key: &str) -> Result<()> {
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
            async fn list_notes(&self) -> Result<Vec<String>> { (**self).list_notes().await }
            async fn read_note(&self, key: &str) -> Result<Option<String>> { (**self).read_note(key).await }
            async fn write_note(&self, key: &str, text: &str) -> Result<()> { (**self).write_note(key, text).await }
            async fn delete_note(&self, key: &str) -> Result<()> { (**self).delete_note(key).await }
            async fn list_blobs(&self) -> Result<Vec<String>> { (**self).list_blobs().await }
            async fn read_blob(&self, name: &str) -> Result<Option<Vec<u8>>> { (**self).read_blob(name).await }
            async fn write_blob(&self, name: &str, bytes: &[u8]) -> Result<()> { (**self).write_blob(name, bytes).await }
            async fn delete_blob(&self, name: &str) -> Result<()> { (**self).delete_blob(name).await }
            async fn read_all_notes(&self) -> Result<Vec<(String, String)>> { (**self).read_all_notes().await }
        }
    };
}
forward_storage!(Box<S>);
forward_storage!(std::rc::Rc<S>);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layered_copies_referenced_base_notes_on_write() {
        pollster::block_on(async {
            let base = Memory::default();
            base.write_note("c", "title: x\nblobs: [a.mp3]\n").await.unwrap();
            base.write_note("unused", "title: y\n").await.unwrap();
            base.write_blob("a.mp3", &[1]).await.unwrap();
            let l = Layered { decks: vec![Deck { source: "demo".into(), aliases: vec![], storage: base }], top: Memory::default() };
            l.write_note("s", "relationships: [{to: c, label: reviews}]\n").await.unwrap();
            assert_eq!(l.top.list_notes().await.unwrap(), vec!["c", "s"]);
            assert_eq!(l.top.list_blobs().await.unwrap(), vec!["a.mp3"]);
            assert!(l.read_note("c").await.unwrap().unwrap().contains("source: demo"));
            assert_eq!(l.list_notes().await.unwrap().len(), 3);
        });
    }

    #[test]
    fn a_tombstone_in_top_hides_the_deck_note() {
        pollster::block_on(async {
            let base = Memory::default();
            base.write_note("c", "title: x\n").await.unwrap();
            let repo = crate::Repo::new(Layered { decks: vec![Deck { source: "demo".into(), aliases: vec![], storage: base }], top: Memory::default() }, crate::Gestalts::builtin());
            repo.load().await.unwrap();
            repo.delete("c", "2026-11-04T10:00:00Z").await.unwrap();
            repo.load().await.unwrap();
            assert!(repo.get("c").is_none());
            // a note referencing it doesn't copy it back, and neither does pulling upstream
            repo.put_raw("s", "relationships: [{to: c, label: reviews}]\n").await.unwrap();
            let s = repo.storage();
            crate::pull_upstream(&s.deck_refs(), &s.top).await.unwrap();
            assert!(crate::is_tombstone_text(&s.top.read_note("c").await.unwrap().unwrap()));
        });
    }
}
