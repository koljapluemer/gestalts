//! Which blobs notes use, and collecting the ones nothing uses any more.
//!
//! Blobs are content-addressed, so they're never edited and never tombstoned (a tombstone would keep the same
//! content from being attached again). A blob is live while a note that isn't a tombstone lists it in `blobs`, uses
//! it (an `![[embed]]`, a field of type `blob`), or a conflict record holds a value that does. Each writable storage
//! collects after a successful sync, and only what stayed unreferenced for [`GC_MIN_DAYS`] and [`GC_MIN_SYNCS`].

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_yaml_ng::Value;

use crate::gestalt::{FieldRule, FieldType, Gestalts, Lint};
use crate::merge::is_tombstone;
use crate::note::Note;
use crate::storage::{Result, Storage};

pub const GC_MIN_DAYS: i64 = 7;
pub const GC_MIN_SYNCS: u32 = 3;

/// The blobs a note uses other than through its `blobs` list: `![[embeds]]` in `main`, `extra` and its cards, and
/// fields its gestalts type as `blob`.
pub fn used_blobs(note: &Note, gestalts: &Gestalts) -> Vec<String> {
    let mut out = Vec::new();
    let Some(v) = &note.value else { return out };
    let texts = ["main", "extra"].iter().filter_map(|k| v.get(*k).and_then(Value::as_str)).map(str::to_owned);
    let cards = v.get("cards").and_then(Value::as_sequence).into_iter().flatten().flat_map(|c| {
        ["front", "back"].into_iter().filter_map(|k| c.get(k).and_then(Value::as_str).map(str::to_owned)).collect::<Vec<_>>()
    });
    for t in texts.chain(cards) {
        embeds(&t, &mut out);
    }
    for d in gestalts.defs().iter().filter(|d| d.is_candidate(note)) {
        for (field, rule) in &d.fields {
            typed(v.get(field.as_str()), rule, &mut out);
        }
    }
    out.dedup();
    out
}

/// `![[name]]` and `![[name|label]]` outside fenced code.
fn embeds(text: &str, out: &mut Vec<String>) {
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
}

fn typed(v: Option<&Value>, rule: &FieldRule, out: &mut Vec<String>) {
    let Some(v) = v else { return };
    match (rule.ty, v) {
        (FieldType::Blob, Value::String(s)) if !out.contains(s) => out.push(s.clone()),
        (FieldType::Map, Value::Mapping(m)) => {
            for (k, r) in &rule.fields {
                typed(m.get(k.as_str()), r, out);
            }
            if let Some(r) = &rule.values {
                m.values().for_each(|item| typed(Some(item), r, out));
            }
        }
        (FieldType::List, Value::Sequence(items)) => {
            if let Some(r) = &rule.items {
                items.iter().for_each(|item| typed(Some(item), r, out));
            }
        }
        _ => {}
    }
}

/// A lint for each blob the note uses but doesn't list in `blobs`.
pub fn unlisted_blobs(note: &Note, gestalts: &Gestalts) -> Vec<Lint> {
    let listed: Vec<String> = note.blobs().into_iter().map(|b| b.target).collect();
    used_blobs(note, gestalts)
        .into_iter()
        .filter(|b| !listed.contains(b))
        .map(|b| Lint { gestalt: "note".into(), path: "blobs".into(), message: format!("uses `{b}`, which isn't listed in `blobs`") })
        .collect()
}

/// Every blob in use by these notes (`(key, text)`), tombstones aside; conflict records keep the blobs of their values.
pub fn referenced_blobs<'a>(notes: impl IntoIterator<Item = (&'a str, &'a str)>, gestalts: &Gestalts) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for (key, text) in notes {
        let note = Note::parse(key, text);
        let Some(v) = &note.value else { continue };
        if is_tombstone(v) {
            continue;
        }
        out.extend(note.blobs().into_iter().map(|b| b.target));
        out.extend(used_blobs(&note, gestalts));
        if note.has_tag("conflict") {
            for side in ["base", "kept", "lost"] {
                if let Some(value @ Value::Mapping(_)) = v.get(side) {
                    let inner = Note { key: key.to_owned(), raw: String::new(), value: Some(value.clone()), parse_error: None };
                    out.extend(inner.blobs().into_iter().map(|b| b.target));
                    out.extend(used_blobs(&inner, gestalts));
                }
            }
        }
    }
    out
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

/// Deletes the blobs of `storage` that `referenced` doesn't hold and that stayed unreferenced for at least
/// [`GC_MIN_DAYS`] and [`GC_MIN_SYNCS`] calls; run it once after each successful sync. Returns the deleted names.
pub async fn collect_blobs(storage: &dyn Storage, referenced: &BTreeSet<String>, manifest: &mut GcManifest, now_ms: i64) -> Result<Vec<String>> {
    let present = storage.list_blobs().await?;
    manifest.pending.retain(|name, _| present.contains(name) && !referenced.contains(name));
    let mut deleted = Vec::new();
    for name in present.iter().filter(|n| !referenced.contains(*n)) {
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

    #[test]
    fn finds_embeds_and_typed_fields() {
        let g = Gestalts::builtin();
        let n = Note::parse("k", "main: \"see ![[a.webp]] and ![[b.mp4|clip]]\\n```\\n![[not.png]]\\n```\\n\"\ncards: [{id: x, front: '![[c.png]]', back: y}]\nblobs: [a.webp]\n");
        assert_eq!(used_blobs(&n, &g), vec!["a.webp", "b.mp4", "c.png"]);
        assert_eq!(unlisted_blobs(&n, &g).len(), 2);
        let g = crate::gestalt::tests::with_plugins();
        let t = Note::parse("t", "tags: [typst]\nsource: x\nassets: {/a.png: a.png}\n");
        assert_eq!(used_blobs(&t, &g), vec!["a.png"]);
        assert_eq!(g.lint(&t), vec![]);
        assert!(!unlisted_blobs(&t, &g).is_empty());
    }

    #[test]
    fn referenced_skips_tombstones_and_keeps_conflict_values() {
        let g = Gestalts::builtin();
        let notes = [
            ("a", "blobs: [x.png]\n"),
            ("b", "id: b\ndeleted: 2026-01-01T00:00:00Z\n"),
            ("c", "tags: [conflict]\nnote: d\npath: []\nlost: {blobs: [y.png]}\n"),
        ];
        let r = referenced_blobs(notes.iter().map(|(k, t)| (*k, *t)), &g);
        assert_eq!(r.into_iter().collect::<Vec<_>>(), vec!["x.png", "y.png"]);
    }

    #[test]
    fn collects_only_after_days_and_syncs() {
        pollster::block_on(async {
            let s = Memory::default();
            s.write_blob("old.png", &[1]).await.unwrap();
            s.write_blob("used.png", &[2]).await.unwrap();
            let referenced: BTreeSet<String> = ["used.png".to_owned()].into();
            let mut m = GcManifest::default();
            let day = 86_400_000;
            for i in 0..3 {
                assert!(collect_blobs(&s, &referenced, &mut m, i).await.unwrap().is_empty(), "too soon");
            }
            assert_eq!(collect_blobs(&s, &referenced, &mut m, 8 * day).await.unwrap(), vec!["old.png"]);
            assert_eq!(s.list_blobs().await.unwrap(), vec!["used.png"]);
            // referenced again meanwhile: starts over
            s.write_blob("back.png", &[3]).await.unwrap();
            collect_blobs(&s, &referenced, &mut m, 9 * day).await.unwrap();
            let referenced: BTreeSet<String> = ["used.png".to_owned(), "back.png".to_owned()].into();
            collect_blobs(&s, &referenced, &mut m, 10 * day).await.unwrap();
            assert!(m.pending.is_empty());
        });
    }
}
