//! Three-way merge of one note, and syncing two storages against a base snapshot.
//!
//! A note merges by its policy: the default (`tags`, `relationships` and `blobs` as sets; `main`, `extra` and
//! `tasks` as text; everything else per key) with the `merge:` rules of every gestalt the note is a candidate for on
//! any of the three sides laid over it ([`note_policy`]). The engine is `gestalts-merge`, which is symmetric: nothing
//! depends on which side is local.
//!
//! Before the engine:
//! - one side changed (vs. the base): take it, deletes included
//! - a side missing while the base has the note was deleted by hand: it counts as a tombstone
//! - a tombstone against an edit: the tombstone wins, and the edit is kept as a conflict, to restore it from
//! - two tombstones: the later one
//! - unparseable or not a map: the whole text is a conflict
//!
//! Every conflict no rule settles becomes a `conflict@1` note ([`conflict_note`]) on all three sides.

use std::collections::{BTreeSet, HashMap};

use gestalts_merge::{Conflict, Policy, Segment, canonical};
use serde::Serialize;
use serde_yaml_ng::{Mapping, Value};

use crate::gestalt::Gestalts;
use crate::note::{Note, parse_yaml, to_yaml};
use crate::repo::stable_id;
use crate::storage::{Result, Storage};
use crate::upstream::content_hash;

/// The outcome of merging one note.
#[derive(Debug, PartialEq)]
pub struct NoteMerge {
    /// `None`: the note is absent (it was on neither side)
    pub text: Option<String>,
    pub conflicts: Vec<Conflict>,
    /// the conflicts are over the whole text (unparseable, not a map), values being raw text
    pub raw: bool,
}

/// `{id, deleted}`: a note deleted at `deleted`. Kept forever, so a delete syncs like any other change.
pub fn is_tombstone(value: &Value) -> bool {
    value.as_mapping().is_some_and(|m| m.contains_key("deleted") && m.keys().all(|k| matches!(k.as_str(), Some("id" | "deleted"))))
}

pub fn is_tombstone_text(text: &str) -> bool {
    parse_yaml(text).is_ok_and(|v| is_tombstone(&v))
}

/// The tombstone of the note `id`, deleted at `now` (an ISO datetime).
pub fn tombstone(id: &str, now: &str) -> String {
    let mut m = Mapping::new();
    m.insert("id".into(), id.into());
    m.insert("deleted".into(), now.into());
    to_yaml(&Value::Mapping(m))
}

/// `unix_ms` as an ISO datetime in UTC (`2026-11-04T10:00:00.000Z`), for hosts that have a clock but no date library.
pub fn iso_datetime(unix_ms: i64) -> String {
    let (days, ms) = (unix_ms.div_euclid(86_400_000), unix_ms.rem_euclid(86_400_000));
    // civil from days, after Howard Hinnant
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    let (h, min, s, milli) = (ms / 3_600_000, ms / 60_000 % 60, ms / 1000 % 60, ms % 1000);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{min:02}:{s:02}.{milli:03}Z")
}

/// The policy every note has.
pub fn default_policy() -> Policy {
    let mut keys = std::collections::BTreeMap::new();
    for k in ["tags", "relationships", "blobs"] {
        keys.insert(k.to_owned(), Policy::Set);
    }
    for k in ["main", "extra", "tasks"] {
        keys.insert(k.to_owned(), Policy::Text);
    }
    Policy::Map(keys)
}

/// The default, with the policies of every gestalt any of `notes` is a candidate for laid over it. Gestalts that
/// disagree on a value make it a conflict.
pub fn note_policy(gestalts: &Gestalts, notes: &[&Note]) -> Policy {
    let mut declared: Option<Policy> = None;
    for d in gestalts.defs() {
        let Some(p) = d.merge_policy() else { continue };
        if notes.iter().any(|n| d.is_candidate(n)) {
            declared = Some(match declared {
                Some(q) => q.combine(&p),
                None => p,
            });
        }
    }
    match declared {
        Some(p) => default_policy().overlay(&p),
        None => default_policy(),
    }
}

/// Merges one note. `now` dates the tombstone of a note removed by hand.
pub fn merge_note(key: &str, base: Option<&str>, local: Option<&str>, remote: Option<&str>, gestalts: &Gestalts, now: &str) -> NoteMerge {
    let take = |t: Option<&str>| NoteMerge { text: t.map(str::to_owned), conflicts: vec![], raw: false };
    // a note removed by hand is a delete: the base says it was there
    let removed = base.map(|b| tombstone(Note::parse(key, b).id(), now));
    let local = local.or(removed.as_deref());
    let remote = remote.or(removed.as_deref());
    if local == remote {
        return take(local);
    }
    if remote == base {
        return take(local);
    }
    if local == base {
        return take(remote);
    }
    let (Some(l), Some(r)) = (local, remote) else {
        // without a base, a note on one side only
        return take(local.or(remote));
    };
    let (lv, rv) = (parse_yaml(l).ok(), parse_yaml(r).ok());
    let bv = base.and_then(|b| parse_yaml(b).ok());
    let (Some(lm), Some(rm)) = (lv.as_ref().filter(|v| v.is_mapping()), rv.as_ref().filter(|v| v.is_mapping())) else {
        return raw_conflict(base, l, r);
    };
    match (is_tombstone(lm), is_tombstone(rm)) {
        (true, true) => {
            let deleted = |v: &Value| v.get("deleted").map(canonical).unwrap_or_default();
            let later = match deleted(lm).cmp(&deleted(rm)) {
                std::cmp::Ordering::Equal => l.max(r),
                std::cmp::Ordering::Greater => l,
                std::cmp::Ordering::Less => r,
            };
            return take(Some(later));
        }
        (true, false) | (false, true) => {
            let (tomb, edit_v) = if is_tombstone(lm) { (l, rm) } else { (r, lm) };
            let conflict = Conflict { path: vec![], base: bv.clone(), kept: Some(parse_yaml(tomb).unwrap_or(Value::Null)), lost: Some(edit_v.clone()) };
            return NoteMerge { text: Some(tomb.to_owned()), conflicts: vec![conflict], raw: false };
        }
        (false, false) => {}
    }
    let notes: Vec<Note> = [base, Some(l), Some(r)].into_iter().flatten().map(|t| Note::parse(key, t)).collect();
    let policy = note_policy(gestalts, &notes.iter().collect::<Vec<_>>());
    let out = gestalts_merge::merge(&policy, bv.as_ref().filter(|v| v.is_mapping()), Some(lm), Some(rm));
    let text = match out.value {
        None => None,
        Some(v) if v == *lm && v == *rm => Some(l.max(r).to_owned()),
        Some(v) if v == *lm => Some(l.to_owned()),
        Some(v) if v == *rm => Some(r.to_owned()),
        Some(v) => Some(to_yaml(&v)),
    };
    NoteMerge { text, conflicts: out.conflicts, raw: false }
}

/// Both texts changed and one doesn't parse as a map: keep the greater text, and record the other.
fn raw_conflict(base: Option<&str>, l: &str, r: &str) -> NoteMerge {
    let (kept, lost) = if l >= r { (l, r) } else { (r, l) };
    let s = |t: &str| Value::String(t.to_owned());
    let conflict = Conflict { path: vec![], base: base.map(s), kept: Some(s(kept)), lost: Some(s(lost)) };
    NoteMerge { text: Some(kept.to_owned()), conflicts: vec![conflict], raw: true }
}

/// The `conflict@1` note recording `c` in the note `key` (whose id is `note_id`): `(key, text)`. Its key depends on
/// the note, the path and the values, so devices recording the same conflict write the same note, and a new conflict
/// at the same path doesn't overwrite an unresolved older one.
pub fn conflict_note(key: &str, note_id: &str, c: &Conflict, raw: bool, now: &str) -> (String, String) {
    let path = Value::Sequence(c.path.iter().map(segment_value).collect());
    let opt = |v: &Option<Value>| v.as_ref().map(canonical).unwrap_or_default();
    let fingerprint = content_hash(format!("{}|{}|{}", opt(&c.base), opt(&c.kept), opt(&c.lost)).as_bytes());
    let ck = stable_id("conflict", &format!("{key}#{}#{fingerprint}", canonical(&path)));
    let mut m = Mapping::new();
    m.insert("id".into(), ck.clone().into());
    m.insert("title".into(), format!("Conflict in {key}{}", path_label(&c.path)).into());
    m.insert("tags".into(), Value::Sequence(vec!["conflict".into()]));
    let mut rel = Mapping::new();
    rel.insert("to".into(), note_id.into());
    rel.insert("label".into(), "conflict-of".into());
    m.insert("relationships".into(), Value::Sequence(vec![Value::Mapping(rel)]));
    m.insert("note".into(), key.into());
    m.insert("path".into(), path);
    if raw {
        m.insert("raw".into(), true.into());
    }
    m.insert("recorded".into(), now.into());
    for (k, v) in [("base", &c.base), ("kept", &c.kept), ("lost", &c.lost)] {
        if let Some(v) = v {
            m.insert(k.into(), v.clone());
        }
    }
    (ck, to_yaml(&Value::Mapping(m)))
}

fn segment_value(s: &Segment) -> Value {
    match s {
        Segment::Key(k) => k.as_str().into(),
        Segment::Item { by, id } => {
            let mut m = Mapping::new();
            m.insert("by".into(), by.as_str().into());
            m.insert("id".into(), id.clone());
            Value::Mapping(m)
        }
    }
}

fn path_label(path: &[Segment]) -> String {
    if path.is_empty() {
        return String::new();
    }
    let parts: Vec<String> = path
        .iter()
        .map(|s| match s {
            Segment::Key(k) => k.clone(),
            Segment::Item { id, .. } => format!("[{}]", id.as_str().map_or_else(|| canonical(id), str::to_owned)),
        })
        .collect();
    format!(": {}", parts.join("."))
}

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
}

#[derive(Debug, Default, Serialize)]
pub struct NoteCounts {
    pub local: usize,
    pub remote: usize,
    pub base: usize,
}

/// The steps `sync_with` reports as it finishes them, in order.
pub const SYNC_STEPS: [&str; 5] = ["read_local", "read_remote", "read_base", "merge_notes", "blobs"];

/// Syncs `local` and `remote` against `base`, the state both had after the last sync.
/// Afterwards all three hold the same notes. `now` (an ISO datetime) dates tombstones and conflict records.
pub async fn sync(local: &dyn Storage, remote: &dyn Storage, base: &dyn Storage, gestalts: &Gestalts, now: &str) -> Result<SyncReport> {
    sync_with(local, remote, base, gestalts, now, &mut |_| {}).await
}

/// `sync`, calling `step` with each of `SYNC_STEPS` as it's done (to time them; the core has no clock).
pub async fn sync_with(local: &dyn Storage, remote: &dyn Storage, base: &dyn Storage, gestalts: &Gestalts, now: &str, step: &mut dyn FnMut(&str)) -> Result<SyncReport> {
    let mut report = SyncReport::default();
    let all = |v: Vec<(String, String)>| v.into_iter().collect::<HashMap<_, _>>();
    let l = all(local.read_all_notes().await?);
    step("read_local");
    let r = all(remote.read_all_notes().await?);
    step("read_remote");
    let b = all(base.read_all_notes().await?);
    step("read_base");
    report.notes = NoteCounts { local: l.len(), remote: r.len(), base: b.len() };
    // sorted, so the report lists keys in order
    let keys: BTreeSet<&str> = l.keys().chain(r.keys()).chain(b.keys()).map(String::as_str).collect();
    let mut merged: Vec<(String, String)> = Vec::new();

    for key in keys {
        let (lt, rt, bt) = (l.get(key).map(String::as_str), r.get(key).map(String::as_str), b.get(key).map(String::as_str));
        let m = merge_note(key, bt, lt, rt, gestalts, now);
        let Some(text) = m.text.as_deref() else { continue };
        if Some(text) != lt {
            local.write_note(key, text).await?;
            report.pulled.push(key.to_owned());
        }
        if Some(text) != rt {
            remote.write_note(key, text).await?;
            report.pushed.push(key.to_owned());
        }
        if Some(text) != bt {
            base.write_note(key, text).await?;
        }
        merged.push((key.to_owned(), text.to_owned()));
        let id = Note::parse(key, text).id().to_owned();
        for c in &m.conflicts {
            let (ck, ct) = conflict_note(key, &id, c, m.raw, now);
            // recorded earlier (by this or another device): keep that record
            let known = [&l, &r, &b].iter().any(|s| s.contains_key(&ck));
            if !known {
                for s in [local, remote, base] {
                    s.write_note(&ck, &ct).await?;
                }
                merged.push((ck.clone(), ct));
                report.conflicts.push(ck);
            }
        }
    }

    step("merge_notes");

    // only blobs a merged note uses go over, so collecting on one side isn't undone by the other
    let used = crate::blobs::referenced_blobs(merged.iter().map(|(k, t)| (k.as_str(), t.as_str())), gestalts);
    let (lb, rb) = (local.list_blobs().await?, remote.list_blobs().await?);
    for name in rb.iter().filter(|n| !lb.contains(n) && used.contains(*n)) {
        if let Some(bytes) = remote.read_blob(name).await? {
            local.write_blob(name, &bytes).await?;
            report.blobs_pulled.push(name.clone());
        }
    }
    for name in lb.iter().filter(|n| !rb.contains(n) && used.contains(*n)) {
        if let Some(bytes) = local.read_blob(name).await? {
            remote.write_blob(name, &bytes).await?;
            report.blobs_pushed.push(name.clone());
        }
    }
    step("blobs");
    Ok(report)
}

#[cfg(test)]
mod tests;
