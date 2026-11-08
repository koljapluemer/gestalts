//! Which blobs ymls use, and collecting the ones nothing uses any more.
//!
//! Blobs are content-addressed, so they're never edited and never tombstoned. A yml's own definition says which blobs
//! it uses. A yml this device can't read by a definition (an unknown gestalt, or an invalid yml) is scanned: any string
//! in it may name a blob. An invalid yml means what's in use can't be known for sure, so nothing is collected while
//! one exists. Each writable storage collects after a successful sync, and only what stayed unreferenced for
//! [`GC_MIN_DAYS`] and [`GC_MIN_SYNCS`].

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_yaml_ng::Value;

use crate::gestalt::{Gestalts, YmlState};
use crate::storage::{Result, Storage};
use crate::yml::{Yml, valid_key};

pub const GC_MIN_DAYS: i64 = 7;
pub const GC_MIN_SYNCS: u32 = 3;

/// `![[name]]` and `![[name|label]]` outside fenced code.
pub fn embeds(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut fenced = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        let mut rest = line;
        while let Some(i) = rest.find("![[") {
            rest = &rest[i + 3..];
            let Some(end) = rest.find("]]") else { break };
            let target = rest[..end].split('|').next().unwrap_or("").trim();
            if !target.is_empty() && !out.iter().any(|o| o == target) {
                out.push(target.to_owned());
            }
            rest = &rest[end + 2..];
        }
    }
    out
}

/// Every string anywhere in `v` that could name a blob, plus the embeds in any string.
pub fn scan(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) => {
            if valid_key(s) {
                out.push(s.clone());
            }
            out.extend(embeds(s));
        }
        Value::Sequence(items) => items.iter().for_each(|i| scan(i, out)),
        Value::Mapping(m) => m.values().for_each(|i| scan(i, out)),
        Value::Tagged(t) => scan(&t.value, out),
        _ => {}
    }
}

/// The blobs `yml` (whose state is `state`) may use.
pub fn blobs_of(yml: &Yml, state: &YmlState, gestalts: &Gestalts) -> Vec<String> {
    let mut out = Vec::new();
    match state {
        YmlState::Tombstone => {}
        YmlState::Valid(g) => {
            if let (Some(def), Some(m)) = (gestalts.get(g), yml.map()) {
                out = def.blob_names(m);
            }
        }
        YmlState::Unknown(_) | YmlState::Invalid(_) => {
            if let Some(v) = &yml.value {
                scan(v, &mut out);
            }
        }
    }
    out
}

/// The blobs in use by a set of ymls.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct BlobRefs {
    pub used: BTreeSet<String>,
    /// no invalid yml was among them, so `used` can be trusted to be everything
    pub complete: bool,
}

impl BlobRefs {
    pub fn new() -> Self {
        BlobRefs { used: BTreeSet::new(), complete: true }
    }

    pub fn add(&mut self, yml: &Yml, state: &YmlState, gestalts: &Gestalts) {
        self.complete &= !matches!(state, YmlState::Invalid(_));
        self.used.extend(blobs_of(yml, state, gestalts));
    }
}

/// The blobs in use by these ymls (`(id, text)`).
pub fn referenced_blobs<'a>(ymls: impl IntoIterator<Item = (&'a str, &'a str)>, gestalts: &Gestalts) -> BlobRefs {
    let mut refs = BlobRefs::new();
    for (id, text) in ymls {
        let yml = Yml::parse(id, text);
        refs.add(&yml, &gestalts.classify(&yml), gestalts);
    }
    refs
}

/// Blobs a storage found unreferenced: since when (unix ms) and over how many collections since.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct GcManifest {
    pub pending: BTreeMap<String, Pending>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pending {
    pub first_unreferenced_ms: i64,
    pub syncs: u32,
}

/// Deletes the blobs of `storage` that `refs` doesn't hold and that stayed unreferenced for at least [`GC_MIN_DAYS`]
/// and [`GC_MIN_SYNCS`] calls; run it once after each successful sync. Does nothing while `refs` is incomplete, nor
/// does that time count towards collecting anything. Returns the deleted names.
pub async fn collect_blobs(storage: &dyn Storage, refs: &BlobRefs, manifest: &mut GcManifest, now_ms: i64) -> Result<Vec<String>> {
    if !refs.complete {
        manifest.pending.clear();
        return Ok(Vec::new());
    }
    let present = storage.list_blobs().await?;
    manifest.pending.retain(|name, _| present.contains(name) && !refs.used.contains(name));
    let mut deleted = Vec::new();
    for name in present.iter().filter(|n| !refs.used.contains(*n)) {
        let p = manifest.pending.entry(name.clone()).or_insert(Pending { first_unreferenced_ms: now_ms, syncs: 0 });
        p.syncs += 1;
        if now_ms - p.first_unreferenced_ms >= GC_MIN_DAYS * 86_400_000 && p.syncs >= GC_MIN_SYNCS {
            storage.delete_blob(name).await?;
            manifest.pending.remove(name);
            deleted.push(name.clone());
        }
    }
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Memory;

    const DAY: i64 = 86_400_000;

    fn refs(ymls: &[(&str, &str)]) -> BlobRefs {
        referenced_blobs(ymls.iter().copied(), &Gestalts::builtin())
    }

    #[test]
    fn embeds_skip_fenced_code() {
        assert_eq!(embeds("see ![[a.webp]] and ![[b.mp4|clip]]\n```\n![[not.png]]\n```\n"), vec!["a.webp", "b.mp4"]);
    }

    #[test]
    fn valid_ymls_answer_by_their_definition() {
        let r = refs(&[
            ("a", "id: a\ngestalt: note@1\nmain: '![[e.png]]'\nblobs: [{file: x.png, label: pic}]\n"),
            ("b", "id: b\ndeleted: 2026-01-01T00:00:00Z\n"),
        ]);
        assert_eq!(r.used.into_iter().collect::<Vec<_>>(), vec!["e.png", "x.png"]);
        assert!(r.complete);
    }

    #[test]
    fn a_title_naming_a_blob_doesnt_keep_it() {
        let r = refs(&[("a", "id: a\ngestalt: note@1\ntitle: x.png\n")]);
        assert!(r.used.is_empty());
    }

    #[test]
    fn conflicts_keep_the_blobs_of_their_values() {
        let r = refs(&[("c", "id: c\ngestalt: conflict@1\nof: n\npath: []\nrecorded: 2026-01-01T00:00:00Z\nlost: {blobs: [{file: y.png, label: pic}]}\n")]);
        assert!(r.used.contains("y.png"));
    }

    #[test]
    fn unknown_gestalts_are_scanned() {
        let r = refs(&[("u", "id: u\ngestalt: from-a-plugin@1\nsomewhere: {deep: [kept.png]}\n")]);
        assert!(r.used.contains("kept.png"));
        assert!(r.complete, "an unknown gestalt doesn't stop collection");
    }

    #[test]
    fn an_invalid_yml_pauses_collection() {
        pollster::block_on(async {
            let s = Memory::default();
            s.write_blob("old.png", &[1]).await.unwrap();
            let mut m = GcManifest::default();
            for (i, bad) in [("a", "title: no gestalt\n"), ("b", "a: [unclosed")].into_iter().enumerate() {
                let r = refs(&[bad]);
                assert!(!r.complete);
                for day in 0..20 {
                    assert!(collect_blobs(&s, &r, &mut m, (i as i64 * 100 + day) * DAY).await.unwrap().is_empty());
                }
            }
            assert_eq!(s.list_blobs().await.unwrap(), vec!["old.png"]);
            assert!(m.pending.is_empty(), "time paused must not count");
        });
    }

    #[test]
    fn collects_only_after_days_and_syncs() {
        pollster::block_on(async {
            let s = Memory::default();
            s.write_blob("old.png", &[1]).await.unwrap();
            s.write_blob("used.png", &[2]).await.unwrap();
            let held = |names: &[&str]| BlobRefs { used: names.iter().map(|n| (*n).to_owned()).collect(), complete: true };
            let mut m = GcManifest::default();
            for i in 0..3 {
                assert!(collect_blobs(&s, &held(&["used.png"]), &mut m, i).await.unwrap().is_empty(), "too soon");
            }
            assert_eq!(collect_blobs(&s, &held(&["used.png"]), &mut m, 8 * DAY).await.unwrap(), vec!["old.png"]);
            assert_eq!(s.list_blobs().await.unwrap(), vec!["used.png"]);
            s.write_blob("back.png", &[3]).await.unwrap();
            collect_blobs(&s, &held(&["used.png"]), &mut m, 9 * DAY).await.unwrap();
            collect_blobs(&s, &held(&["used.png", "back.png"]), &mut m, 10 * DAY).await.unwrap();
            assert!(m.pending.is_empty());
        });
    }
}
