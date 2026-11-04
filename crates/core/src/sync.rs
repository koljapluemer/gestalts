//! Syncing two storages against a base, the state both had after the last sync, note by note with
//! [`merge_note`](crate::merge::merge_note).
//!
//! A sync reads only what changed. Each side lists `{key: hash}` ([`Storage::note_hashes`]), the base keeps the
//! hashes it agreed on in a manifest ([`SyncBase`]), and only the notes whose three hashes differ are read. Unchanged
//! notes cost nothing.
//!
//! It runs in three phases, so a host can let its own writes go ahead while the network is busy:
//! 1. [`fetch_remote`]: network only. The remote hashes, the remote texts that changed since the base, and the blobs
//!    those use that this side lacks.
//! 2. [`merge_local`]: local only. Merges, writes the local side, and returns what still has to go out.
//! 3. [`push`]: network only. Blobs first, then the notes, then the base.
//!
//! The base moves only once both sides hold a text. If a phase fails, the next sync redoes what's left: the merge is
//! symmetric, so redoing it gives the same result.

use std::collections::{BTreeSet, HashMap, HashSet};

use serde::Serialize;

use crate::blobs::referenced_blobs;
use crate::gestalt::Gestalts;
use crate::merge::{conflict_note, merge_note};
use crate::note::Note;
use crate::storage::{Hashes, Result, Storage, StorageError};
use crate::upstream::content_hash;

#[derive(Debug, Default, Serialize)]
pub struct SyncReport {
    /// notes changed locally because of remote
    pub pulled: Vec<String>,
    /// notes changed remotely because of local
    pub pushed: Vec<String>,
    /// `conflict@1` notes written
    pub conflicts: Vec<String>,
    pub blobs_pulled: Vec<String>,
    pub blobs_pushed: Vec<String>,
    /// how many notes each side had before the sync
    pub notes: NoteCounts,
    /// how many note texts the sync read: those whose hashes differed
    pub compared: usize,
}

#[derive(Debug, Default, Serialize)]
pub struct NoteCounts {
    pub local: usize,
    pub remote: usize,
    pub base: usize,
}

/// The steps `sync_with` reports as it finishes them, in order.
pub const SYNC_STEPS: [&str; 6] = ["open_base", "remote_hashes", "fetch_remote", "local_hashes", "merge_notes", "push"];

/// The base's blob holding its manifest.
pub const MANIFEST: &str = "manifest.json";

/// The base of a sync: the texts both sides agreed on (its notes), and a manifest of their hashes (the blob
/// [`MANIFEST`]). A sync reads the manifest, and a base text only for a note both sides changed.
pub struct SyncBase<B> {
    store: B,
    manifest: Hashes,
    dirty: bool,
}

impl<B: Storage> SyncBase<B> {
    /// Opens the base in `store`. A base without a manifest (written before there were manifests, or never saved)
    /// gets one from its notes.
    pub async fn open(store: B) -> Result<Self> {
        let saved = store.read_blob(MANIFEST).await?.and_then(|b| serde_json::from_slice::<Hashes>(&b).ok());
        let mut base = match saved {
            Some(manifest) => SyncBase { store, manifest, dirty: false },
            None => {
                let manifest = store.note_hashes().await?;
                SyncBase { store, manifest, dirty: true }
            }
        };
        base.save().await?;
        Ok(base)
    }

    pub fn hashes(&self) -> &Hashes {
        &self.manifest
    }

    /// The agreed text of `key`. `None` if there is none, or if the stored text isn't the one the manifest agreed on
    /// (a sync stopped between writing the two): merging without a base is safer than against the wrong one.
    pub async fn text(&self, key: &str) -> Result<Option<String>> {
        let Some(hash) = self.manifest.get(key) else { return Ok(None) };
        Ok(self.store.read_note(key).await?.filter(|t| content_hash(t.as_bytes()) == *hash))
    }

    /// Records `text` as agreed for `key`; [`save`](Self::save) writes the manifest.
    pub async fn set(&mut self, key: &str, text: &str) -> Result<()> {
        let hash = content_hash(text.as_bytes());
        if self.manifest.get(key) == Some(&hash) {
            return Ok(());
        }
        self.store.write_note(key, text).await?;
        self.manifest.insert(key.to_owned(), hash);
        self.dirty = true;
        Ok(())
    }

    pub async fn save(&mut self) -> Result<()> {
        if self.dirty {
            let json = serde_json::to_vec(&self.manifest).map_err(|e| StorageError::Io(e.to_string()))?;
            self.store.write_blob(MANIFEST, &json).await?;
            self.dirty = false;
        }
        Ok(())
    }
}

/// What [`fetch_remote`] got: the remote side's state, as far as this sync needs it.
pub struct Fetched {
    remote: Hashes,
    /// the remote texts of the notes that changed there since the base
    texts: HashMap<String, String>,
    blobs_pulled: Vec<String>,
}

/// Phase 1, network only: the remote hashes and the texts that changed there since the base, and the blobs those
/// texts use that `local` lacks (written to `local`: blobs are content-addressed, so that can't clash with a write).
pub async fn fetch_remote<B: Storage>(local: &dyn Storage, remote: &dyn Storage, base: &SyncBase<B>, gestalts: &Gestalts,
                                      step: &mut dyn FnMut(&str)) -> Result<Fetched> {
    let remote_hashes = remote.note_hashes().await?;
    step("remote_hashes");
    let changed: Vec<String> = remote_hashes.iter().filter(|(k, h)| base.hashes().get(*k) != Some(*h)).map(|(k, _)| k.clone()).collect();
    let texts: HashMap<String, String> = if changed.is_empty() { HashMap::new() } else { remote.read_notes(&changed).await?.into_iter().collect() };
    let mut blobs_pulled = Vec::new();
    let used = referenced_blobs(texts.iter().map(|(k, t)| (k.as_str(), t.as_str())), gestalts);
    if !used.is_empty() {
        let have: HashSet<String> = local.list_blobs().await?.into_iter().collect();
        for name in used.iter().filter(|n| !have.contains(*n)) {
            if let Some(bytes) = remote.read_blob(name).await? {
                local.write_blob(name, &bytes).await?;
                blobs_pulled.push(name.clone());
            }
        }
    }
    step("fetch_remote");
    Ok(Fetched { remote: remote_hashes, texts, blobs_pulled })
}

/// What [`merge_local`] left for [`push`].
pub struct Pending {
    push: Vec<(String, String)>,
    report: SyncReport,
}

impl Pending {
    /// The report so far: what was pulled and recorded locally, and what is about to be pushed.
    pub fn report(&self) -> &SyncReport {
        &self.report
    }
}

/// Phase 2, local only (but for a damaged base, see below): merges every note whose hashes differ, writes the
/// results to `local`, and moves the base for notes the remote side already has.
///
/// The local text of every note it merges is read anew, so a stale [`Storage::note_hashes`] never makes it write over
/// a local change it hasn't seen.
pub async fn merge_local<B: Storage>(local: &dyn Storage, remote: &dyn Storage, base: &mut SyncBase<B>, fetched: Fetched,
                                     gestalts: &Gestalts, now: &str, step: &mut dyn FnMut(&str)) -> Result<Pending> {
    let local_hashes = local.note_hashes().await?;
    step("local_hashes");
    let base_hashes = base.hashes().clone();
    let remote_hashes = &fetched.remote;
    let mut report = SyncReport {
        blobs_pulled: fetched.blobs_pulled,
        notes: NoteCounts { local: local_hashes.len(), remote: remote_hashes.len(), base: base_hashes.len() },
        ..SyncReport::default()
    };
    // sorted, so the report lists keys in order
    let keys: BTreeSet<&str> = local_hashes.keys().chain(remote_hashes.keys()).chain(base_hashes.keys()).map(String::as_str).collect();
    let known = |k: &str| local_hashes.contains_key(k) || remote_hashes.contains_key(k) || base_hashes.contains_key(k);
    let mut push = Vec::new();

    for key in keys {
        let (l, r, b) = (local_hashes.get(key), remote_hashes.get(key), base_hashes.get(key));
        if l == r && r == b {
            continue;
        }
        report.compared += 1;
        let lt = local.read_note(key).await?;
        let bt = base.text(key).await?;
        let rt = if r == b && (bt.is_some() || b.is_none()) {
            // unchanged there: the remote text is the base's
            bt.clone()
        } else if let Some(t) = fetched.texts.get(key) {
            Some(t.clone())
        } else if r.is_some() {
            // a base whose text doesn't match its manifest: ask for the remote text after all
            remote.read_note(key).await?
        } else {
            None
        };
        let (lt, bt, rt) = (lt.as_deref(), bt.as_deref(), rt.as_deref());
        let m = merge_note(key, bt, lt, rt, gestalts, now);
        let Some(text) = m.text.as_deref() else { continue };
        if Some(text) != lt {
            local.write_note(key, text).await?;
            report.pulled.push(key.to_owned());
        }
        if Some(text) != rt {
            push.push((key.to_owned(), text.to_owned()));
            report.pushed.push(key.to_owned());
        } else {
            base.set(key, text).await?;
        }
        let id = Note::parse(key, text).id().to_owned();
        for c in &m.conflicts {
            let (ck, ct) = conflict_note(key, &id, c, m.raw, now);
            // recorded earlier (by this or another device): keep that record
            if !known(&ck) && !push.iter().any(|(k, _)| *k == ck) {
                local.write_note(&ck, &ct).await?;
                push.push((ck.clone(), ct));
                report.conflicts.push(ck);
            }
        }
    }
    base.save().await?;
    step("merge_notes");
    Ok(Pending { push, report })
}

/// Phase 3, network only: the blobs the pushed notes use that `remote` lacks, then the notes, then the base.
pub async fn push<B: Storage>(local: &dyn Storage, remote: &dyn Storage, base: &mut SyncBase<B>, pending: Pending,
                              gestalts: &Gestalts, step: &mut dyn FnMut(&str)) -> Result<SyncReport> {
    let Pending { push, mut report } = pending;
    if !push.is_empty() {
        // only blobs a pushed note uses go over, so collecting on one side isn't undone by the other
        let used = referenced_blobs(push.iter().map(|(k, t)| (k.as_str(), t.as_str())), gestalts);
        if !used.is_empty() {
            let have: HashSet<String> = remote.list_blobs().await?.into_iter().collect();
            for name in used.iter().filter(|n| !have.contains(*n)) {
                if let Some(bytes) = local.read_blob(name).await? {
                    remote.write_blob(name, &bytes).await?;
                    report.blobs_pushed.push(name.clone());
                }
            }
        }
        remote.write_notes(&push).await?;
        for (k, t) in &push {
            base.set(k, t).await?;
        }
        base.save().await?;
    }
    step("push");
    Ok(report)
}

/// Syncs `local` and `remote` against `base`, the state both had after the last sync.
/// Afterwards all three hold the same notes. `now` (an ISO datetime) dates tombstones and conflict records.
pub async fn sync(local: &dyn Storage, remote: &dyn Storage, base: &dyn Storage, gestalts: &Gestalts, now: &str) -> Result<SyncReport> {
    sync_with(local, remote, base, gestalts, now, &mut |_| {}).await
}

/// `sync`, all three phases in a row, calling `step` with each of `SYNC_STEPS` as it's done (to time them; the core
/// has no clock).
pub async fn sync_with(local: &dyn Storage, remote: &dyn Storage, base: &dyn Storage, gestalts: &Gestalts, now: &str,
                       step: &mut dyn FnMut(&str)) -> Result<SyncReport> {
    let mut base = SyncBase::open(base).await?;
    step("open_base");
    let fetched = fetch_remote(local, remote, &base, gestalts, step).await?;
    let pending = merge_local(local, remote, &mut base, fetched, gestalts, now, step).await?;
    push(local, remote, &mut base, pending, gestalts, step).await
}

#[cfg(test)]
mod tests;
