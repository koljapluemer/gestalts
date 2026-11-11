//! Three-way merge of one yml (syncing two storages with it is [`crate::sync`]).
//!
//! A yml merges by the policy of the one gestalt it names ([`crate::gestalt::GestaltDef::policy`]). One this device has
//! no definition for merges per key, conflicting at the leaves, which loses nothing. The engine is `gestalts-merge`,
//! which is symmetric: nothing depends on which side is local.
//!
//! Before the engine:
//! - one side changed (vs. the base): take it, deletes included
//! - a side missing while the base has the yml was deleted by hand: it counts as a tombstone
//! - a tombstone against an edit: the tombstone wins, and the edit is kept as a conflict, to restore it from
//! - two tombstones: the later one
//! - unparseable, not a map, or the two sides naming different gestalts: the whole text is a conflict
//!
//! Every conflict no rule settles becomes a `conflict@1` yml ([`conflict_yml`]) on all three sides.

use gestalts_merge::{Conflict, Policy, Segment, canonical};
use serde_yaml_ng::{Mapping, Value};

use crate::gestalt::{GestaltDef, Gestalts};
use crate::repo::stable_id;
use crate::yml::{content_hash, parse_yaml, to_yaml};

/// The outcome of merging one yml.
#[derive(Debug, PartialEq)]
pub struct YmlMerge {
    /// `None`: the yml is absent (it was on neither side)
    pub text: Option<String>,
    pub conflicts: Vec<Conflict>,
    /// the conflicts are over the whole text (unparseable, not a map), values being raw text
    pub raw: bool,
}

/// `{id, deleted}`: a yml deleted at `deleted`. Kept forever, so a delete syncs like any other change.
pub fn is_tombstone(value: &Value) -> bool {
    value.as_mapping().is_some_and(|m| m.contains_key("deleted") && m.keys().all(|k| matches!(k.as_str(), Some("id" | "deleted"))))
}

pub fn is_tombstone_text(text: &str) -> bool {
    parse_yaml(text).is_ok_and(|v| is_tombstone(&v))
}

/// The tombstone of the yml `id`, deleted at `now` (an ISO datetime).
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

/// An ISO datetime (`2026-11-04T10:00`, with optional seconds, fraction and `Z` or `±HH:MM`; local times count as
/// UTC) as unix ms, the inverse of [`iso_datetime`]. `None` if it isn't one.
pub fn parse_iso_datetime(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let num = |r: std::ops::Range<usize>| s.get(r).filter(|t| t.bytes().all(|c| c.is_ascii_digit())).and_then(|t| t.parse::<i64>().ok());
    if b.len() < 16 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' {
        return None;
    }
    let (y, m, d, h, min) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || h > 23 || min > 59 {
        return None;
    }
    let mut i = 16;
    let (mut sec, mut milli) = (0, 0);
    if b.get(i) == Some(&b':') {
        sec = num(i + 1..i + 3).filter(|s| *s <= 60)?;
        i += 3;
        if b.get(i) == Some(&b'.') {
            let digits = b[i + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
            if digits == 0 {
                return None;
            }
            let frac = &s[i + 1..i + 1 + digits.min(3)];
            milli = frac.parse::<i64>().ok()? * 10_i64.pow(3 - frac.len() as u32);
            i += 1 + digits;
        }
    }
    let offset_min = match &s[i..] {
        "" | "Z" => 0,
        rest if rest.len() == 6 && (rest.starts_with('+') || rest.starts_with('-')) && rest.as_bytes()[3] == b':' => {
            let o = num(i + 1..i + 3)? * 60 + num(i + 4..i + 6)?;
            if rest.starts_with('-') { -o } else { o }
        }
        _ => return None,
    };
    // days from civil, after Howard Hinnant
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + h) * 60 + min - offset_min) * 60_000 + sec * 1000 + milli)
}

/// Merges one yml. `now` dates the tombstone of a yml removed by hand.
pub fn merge_yml(id: &str, base: Option<&str>, local: Option<&str>, remote: Option<&str>, gestalts: &Gestalts, now: &str) -> YmlMerge {
    let take = |t: Option<&str>| YmlMerge { text: t.map(str::to_owned), conflicts: vec![], raw: false };
    // a yml removed by hand is a delete: the base says it was there
    let removed = base.map(|_| tombstone(id, now));
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
            return YmlMerge { text: Some(tomb.to_owned()), conflicts: vec![conflict], raw: false };
        }
        (false, false) => {}
    }
    let named = |v: &Value| v.get("gestalt").and_then(Value::as_str).map(str::to_owned);
    if named(lm) != named(rm) {
        return raw_conflict(base, l, r);
    }
    let policy = named(lm).and_then(|g| gestalts.get(&g).map(GestaltDef::policy)).unwrap_or_else(Policy::map);
    let out = gestalts_merge::merge(&policy, bv.as_ref().filter(|v| v.is_mapping()), Some(lm), Some(rm));
    let text = match out.value {
        None => None,
        Some(v) if v == *lm && v == *rm => Some(l.max(r).to_owned()),
        Some(v) if v == *lm => Some(l.to_owned()),
        Some(v) if v == *rm => Some(r.to_owned()),
        Some(v) => Some(to_yaml(&v)),
    };
    YmlMerge { text, conflicts: out.conflicts, raw: false }
}

/// Both texts changed and one doesn't parse as a map: keep the greater text, and record the other.
fn raw_conflict(base: Option<&str>, l: &str, r: &str) -> YmlMerge {
    let (kept, lost) = if l >= r { (l, r) } else { (r, l) };
    let s = |t: &str| Value::String(t.to_owned());
    let conflict = Conflict { path: vec![], base: base.map(s), kept: Some(s(kept)), lost: Some(s(lost)) };
    YmlMerge { text: Some(kept.to_owned()), conflicts: vec![conflict], raw: true }
}

/// The `conflict@1` yml recording `c` in the yml `of`: `(id, text)`. Its id depends on the yml, the path and the
/// values, so devices recording the same conflict write the same yml, and a new conflict at the same path doesn't
/// overwrite an unresolved older one.
pub fn conflict_yml(of: &str, c: &Conflict, raw: bool, now: &str) -> (String, String) {
    let path = Value::Sequence(c.path.iter().map(segment_value).collect());
    let opt = |v: &Option<Value>| v.as_ref().map(canonical).unwrap_or_default();
    let fingerprint = content_hash(format!("{}|{}|{}", opt(&c.base), opt(&c.kept), opt(&c.lost)).as_bytes());
    let id = stable_id("conflict", &format!("{of}#{}#{fingerprint}", canonical(&path)));
    let mut m = Mapping::new();
    m.insert("id".into(), id.clone().into());
    m.insert("gestalt".into(), "conflict@1".into());
    m.insert("of".into(), of.into());
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
    (id, to_yaml(&Value::Mapping(m)))
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

#[cfg(test)]
mod tests;
