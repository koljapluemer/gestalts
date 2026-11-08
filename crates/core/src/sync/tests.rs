use std::cell::Cell;

use async_trait::async_trait;
use serde_yaml_ng::Value;

use super::*;
use crate::merge::{is_tombstone_text, tombstone};
use crate::yml::parse_yaml;
use crate::storage::{Memory, Tracked};

const NOW: &str = "2026-11-04T10:00:00Z";

#[test]
fn sync_converges() {
    pollster::block_on(async {
        let g = Gestalts::builtin();
        let (l, r, b) = (Memory::default(), Memory::default(), Memory::default());
        l.write_yml("only-local", "x: 1").await.unwrap();
        r.write_yml("only-remote", "y: 1").await.unwrap();
        r.write_yml("uses-img", "id: uses-img\ngestalt: note@1\nblobs: [{file: img.webp, label: pic}]\n").await.unwrap();
        r.write_blob("img.webp", b"123").await.unwrap();
        r.write_blob("unused.webp", b"9").await.unwrap();
        let rep = sync(&l, &r, &b, &g, NOW).await.unwrap();
        assert_eq!(rep.pulled, vec!["only-remote", "uses-img"]);
        assert_eq!(rep.pushed, vec!["only-local"]);
        assert_eq!(rep.blobs_pulled, vec!["img.webp"]);

        // both edit the same note, different keys; one deletes another
        l.write_yml("only-local", "x: 2\nz: 1").await.unwrap();
        r.write_yml("only-local", "x: 1\nw: 1").await.unwrap();
        r.write_yml("only-remote", &tombstone("only-remote", NOW)).await.unwrap();
        let rep = sync(&l, &r, &b, &g, NOW).await.unwrap();
        assert!(rep.conflicts.is_empty());
        let merged = l.read_yml("only-local").await.unwrap().unwrap();
        assert_eq!(r.read_yml("only-local").await.unwrap().unwrap(), merged);
        assert!(is_tombstone_text(&l.read_yml("only-remote").await.unwrap().unwrap()));

        // a real conflict: the same winner on both sides, and one conflict note
        l.write_yml("only-local", "x: 3").await.unwrap();
        r.write_yml("only-local", "x: 4").await.unwrap();
        let rep = sync(&l, &r, &b, &g, NOW).await.unwrap();
        assert_eq!(rep.conflicts.len(), 1);
        assert_eq!(l.read_yml("only-local").await.unwrap().as_deref(), Some("x: 4"));
        assert_eq!(r.read_yml("only-local").await.unwrap().as_deref(), Some("x: 4"));
        let ck = &rep.conflicts[0];
        let c = parse_yaml(&r.read_yml(ck).await.unwrap().unwrap()).unwrap();
        assert_eq!(c["lost"], Value::from(3));
        assert_eq!(c["path"], parse_yaml("[x]").unwrap());
        assert_eq!(c["of"], Value::from("only-local"));

        // nothing changed: a no-op, and the conflict isn't recorded twice
        let rep = sync(&l, &r, &b, &g, NOW).await.unwrap();
        assert!(rep.pulled.is_empty() && rep.pushed.is_empty() && rep.conflicts.is_empty());
        assert_eq!(rep.compared, 0);
    });
}

/// Counts the note texts read through it.
#[derive(Default)]
struct Counting<S> {
    inner: S,
    reads: Cell<usize>,
    fail_writes: Cell<bool>,
}

#[async_trait(?Send)]
impl<S: Storage> Storage for Counting<S> {
    async fn list_ymls(&self) -> Result<Vec<String>> { self.inner.list_ymls().await }
    async fn read_yml(&self, key: &str) -> Result<Option<String>> {
        self.reads.set(self.reads.get() + 1);
        self.inner.read_yml(key).await
    }
    async fn write_yml(&self, key: &str, text: &str) -> Result<()> {
        if self.fail_writes.get() {
            return Err(StorageError::Io("offline".into()));
        }
        self.inner.write_yml(key, text).await
    }
    async fn delete_yml(&self, key: &str) -> Result<()> { self.inner.delete_yml(key).await }
    async fn list_blobs(&self) -> Result<Vec<String>> { self.inner.list_blobs().await }
    async fn read_blob(&self, name: &str) -> Result<Option<Vec<u8>>> { self.inner.read_blob(name).await }
    async fn write_blob(&self, name: &str, bytes: &[u8]) -> Result<()> { self.inner.write_blob(name, bytes).await }
    async fn delete_blob(&self, name: &str) -> Result<()> { self.inner.delete_blob(name).await }
    async fn read_all_ymls(&self) -> Result<Vec<(String, String)>> {
        let all = self.inner.read_all_ymls().await?;
        self.reads.set(self.reads.get() + all.len());
        Ok(all)
    }
    /// what a node answers without sending texts
    async fn yml_hashes(&self) -> Result<Hashes> {
        Ok(self.inner.read_all_ymls().await?.into_iter().map(|(k, t)| (k, content_hash(t.as_bytes()))).collect())
    }
}

fn counting() -> Counting<Memory> {
    Counting::default()
}

#[test]
fn only_changed_notes_are_read() {
    pollster::block_on(async {
        let g = Gestalts::builtin();
        let local = Tracked::new(counting());
        let (remote, base) = (counting(), counting());
        for i in 0..50 {
            local.write_yml(&format!("n{i}"), &format!("i: {i}")).await.unwrap();
        }
        // a repo opening reads every note, which seeds the hashes
        local.read_all_ymls().await.unwrap();
        sync(&local, &remote, &base, &g, NOW).await.unwrap();
        let reset = || [&local.inner().reads, &remote.reads, &base.reads].iter().for_each(|c| c.set(0));

        reset();
        let rep = sync(&local, &remote, &base, &g, NOW).await.unwrap();
        assert_eq!(rep.compared, 0);
        assert_eq!((local.inner().reads.get(), remote.reads.get(), base.reads.get()), (0, 0, 0));

        local.write_yml("n3", "i: 3\nedited: true").await.unwrap();
        remote.write_yml("n7", "i: 7\nremote: true").await.unwrap();
        reset();
        let rep = sync(&local, &remote, &base, &g, NOW).await.unwrap();
        assert_eq!((rep.pushed, rep.pulled), (vec!["n3".to_owned()], vec!["n7".to_owned()]));
        assert_eq!(rep.compared, 2);
        // one local read per compared note; the remote text read once; base texts only where they exist
        assert_eq!(local.inner().reads.get(), 2);
        assert_eq!(remote.reads.get(), 1);
        assert!(base.reads.get() <= 2);
    });
}

#[test]
fn a_base_without_a_manifest_gets_one() {
    pollster::block_on(async {
        let g = Gestalts::builtin();
        let (l, r, b) = (Memory::default(), Memory::default(), Memory::default());
        for s in [&l, &r, &b] {
            s.write_yml("a", "x: 1").await.unwrap();
        }
        l.write_yml("a", "x: 1\ny: 2").await.unwrap();
        r.write_yml("a", "z: 3\nx: 1").await.unwrap();
        let rep = sync(&l, &r, &b, &g, NOW).await.unwrap();
        assert!(rep.conflicts.is_empty(), "merged against the old base");
        assert!(b.read_blob(MANIFEST).await.unwrap().is_some());
        let merged = l.read_yml("a").await.unwrap().unwrap();
        assert!(merged.contains("y: 2") && merged.contains("z: 3"), "{merged}");
    });
}

#[test]
fn tracked_follows_writes_and_deletes() {
    pollster::block_on(async {
        let t = Tracked::new(Memory::default());
        t.write_yml("a", "x").await.unwrap();
        // not seeded yet: reads everything once
        assert_eq!(t.yml_hashes().await.unwrap().len(), 1);
        t.write_yml("b", "y").await.unwrap();
        t.delete_yml("a").await.unwrap();
        let h = t.yml_hashes().await.unwrap();
        assert_eq!(h.keys().collect::<Vec<_>>(), vec!["b"]);
        assert_eq!(h["b"], content_hash(b"y"));
    });
}

#[test]
fn a_failed_push_is_redone() {
    pollster::block_on(async {
        let g = Gestalts::builtin();
        let (l, r, b) = (Memory::default(), counting(), Memory::default());
        l.write_yml("a", "x: 1").await.unwrap();
        r.fail_writes.set(true);
        assert!(sync(&l, &r, &b, &g, NOW).await.is_err());
        assert!(SyncBase::open(&b as &dyn Storage).await.unwrap().hashes().is_empty(), "the base moved without the remote");
        r.fail_writes.set(false);
        let rep = sync(&l, &r, &b, &g, NOW).await.unwrap();
        assert_eq!(rep.pushed, vec!["a"]);
        assert_eq!(r.read_yml("a").await.unwrap().as_deref(), Some("x: 1"));
    });
}

#[test]
fn a_stale_hash_never_overwrites_a_local_change() {
    pollster::block_on(async {
        let g = Gestalts::builtin();
        let mem = std::rc::Rc::new(Memory::default());
        let local = Tracked::new(mem.clone());
        let (r, b) = (Memory::default(), Memory::default());
        local.write_yml("a", "x: 1").await.unwrap();
        local.read_all_ymls().await.unwrap();
        sync(&local, &r, &b, &g, NOW).await.unwrap();
        // another tab edits "a" behind the tracker's back, while the remote changes it too
        mem.write_yml("a", "x: 1\nother_tab: true").await.unwrap();
        r.write_yml("a", "x: 1\nremote: true").await.unwrap();
        sync(&local, &r, &b, &g, NOW).await.unwrap();
        let merged = mem.read_yml("a").await.unwrap().unwrap();
        assert!(merged.contains("other_tab") && merged.contains("remote"), "{merged}");
        assert_eq!(r.read_yml("a").await.unwrap().unwrap(), merged);
    });
}

#[test]
fn invalid_and_unknown_ymls_sync_byte_for_byte() {
    pollster::block_on(async {
        let g = Gestalts::builtin();
        let (l, r, b) = (Memory::default(), Memory::default(), Memory::default());
        let texts = [("broken", "a: [unclosed"), ("old", "tags: [flashcard]\nfront: x   # a comment\n"), ("u", "id: u\ngestalt: from-a-plugin@1\nweird:   [1,2]\n")];
        for (id, t) in texts {
            l.write_yml(id, t).await.unwrap();
        }
        sync(&l, &r, &b, &g, NOW).await.unwrap();
        for (id, t) in texts {
            assert_eq!(r.read_yml(id).await.unwrap().as_deref(), Some(t));
        }
    });
}

#[test]
fn a_blob_only_a_scanned_yml_names_still_travels() {
    pollster::block_on(async {
        let g = Gestalts::builtin();
        let (l, r, b) = (Memory::default(), Memory::default(), Memory::default());
        l.write_yml("u", "id: u\ngestalt: from-a-plugin@1\npic: kept.png\nother: not-a-blob\n").await.unwrap();
        l.write_blob("kept.png", b"1").await.unwrap();
        let rep = sync(&l, &r, &b, &g, NOW).await.unwrap();
        assert_eq!(rep.blobs_pushed, vec!["kept.png"]);
    });
}
