//! Symmetric, rule-based three-way merge of YAML values.
//!
//! [`merge`] takes a [`Policy`] and three versions of a value: the base (the state both sides last agreed on) and the
//! two sides. It knows nothing of notes or storage. Its laws, property-tested:
//! - identity: `merge(x, x, x) == x`; one side changed: `merge(b, b, r) == r`; idempotence: `merge(b, x, x) == x`
//! - symmetry: `merge(b, x, y) == merge(b, y, x)`, conflicts included. Nothing depends on which side is "local":
//!   a conflict keeps the side whose value sorts greater ([`canonical`]), so any two devices merging the same states
//!   get the same result.
//! - no silent loss: a change that doesn't make it into the result is reported as a [`Conflict`]
//!
//! A missing value (`None`) is a deleted key or note; it sorts before every value.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use serde_yaml_ng::{Mapping, Value};

/// How a value merges. See the crate docs and `doc/gestalts.md#merge`.
#[derive(Debug, Clone, PartialEq)]
pub enum Policy {
    /// a value changed differently on both sides is a conflict
    Conflict,
    /// per key, recursing; keys not listed merge as `Map` too, which is a conflict at the leaves
    Map(BTreeMap<String, Policy>),
    /// a list as a set: additions from either side kept, removals from either side dropped
    Set,
    /// a list of items identified by a field, all of them kept (append-only logs)
    UnionBy(String),
    /// a list of items identified by a field, each merged with `item`
    ListBy { field: String, item: Box<Policy> },
    /// a string, line-level diff3: a conflict only where both changed the same lines
    Text,
    /// the whole side with the greater value at the first of these paths that differs; works without a base
    NewestBy(Vec<Vec<String>>),
    Max,
    Min,
}

impl Policy {
    /// The default for values nobody declared: per key, recursing.
    pub fn map() -> Self {
        Policy::Map(BTreeMap::new())
    }

    /// Parses a gestalt's `merge:` value:
    /// `conflict | map | set | text | max | min`, `{union_by: f}`, `{list_by: f, item?: <policy>}`,
    /// `{newest_by: [a.b, c]}`, `{keys: {k: <policy>}}` and `{whole: <policy>}` (the same as `<policy>`).
    pub fn parse(v: &Value) -> Result<Self, String> {
        match v {
            Value::String(s) => match s.as_str() {
                "conflict" => Ok(Policy::Conflict),
                "map" => Ok(Policy::map()),
                "set" => Ok(Policy::Set),
                "text" => Ok(Policy::Text),
                "max" => Ok(Policy::Max),
                "min" => Ok(Policy::Min),
                other => Err(format!("unknown merge strategy `{other}`")),
            },
            Value::Mapping(m) => {
                let get = |k: &str| m.get(k);
                let only = |allowed: &[&str]| -> Result<(), String> {
                    match m.keys().find(|k| !k.as_str().is_some_and(|k| allowed.contains(&k))) {
                        Some(k) => Err(format!("unexpected `{}` in merge strategy", canonical(k))),
                        None => Ok(()),
                    }
                };
                let field = |v: &Value| v.as_str().map(str::to_owned).ok_or_else(|| "a field name must be a string".to_owned());
                if let Some(w) = get("whole") {
                    only(&["whole"])?;
                    Policy::parse(w)
                } else if let Some(keys) = get("keys") {
                    only(&["keys"])?;
                    let Value::Mapping(keys) = keys else { return Err("`keys` must be a map".into()) };
                    let mut out = BTreeMap::new();
                    for (k, p) in keys {
                        out.insert(field(k)?, Policy::parse(p)?);
                    }
                    Ok(Policy::Map(out))
                } else if let Some(f) = get("union_by") {
                    only(&["union_by"])?;
                    Ok(Policy::UnionBy(field(f)?))
                } else if let Some(f) = get("list_by") {
                    only(&["list_by", "item"])?;
                    let item = get("item").map(Policy::parse).transpose()?.unwrap_or_else(Policy::map);
                    Ok(Policy::ListBy { field: field(f)?, item: Box::new(item) })
                } else if let Some(paths) = get("newest_by") {
                    only(&["newest_by"])?;
                    let Value::Sequence(paths) = paths else { return Err("`newest_by` must be a list of paths".into()) };
                    let paths = paths.iter().map(|p| field(p).map(|p| p.split('.').map(str::to_owned).collect())).collect::<Result<Vec<_>, _>>()?;
                    if paths.is_empty() {
                        return Err("`newest_by` needs at least one path".into());
                    }
                    Ok(Policy::NewestBy(paths))
                } else {
                    Err("a merge strategy map needs one of `whole`, `keys`, `union_by`, `list_by`, `newest_by`".into())
                }
            }
            _ => Err("a merge strategy is a name or a map".into()),
        }
    }

    /// Two declared policies for the same value: the same, or merged per key where both are maps; where they
    /// disagree, `Conflict`.
    pub fn combine(&self, other: &Policy) -> Policy {
        match (self, other) {
            (a, b) if a == b => a.clone(),
            (Policy::Map(a), Policy::Map(b)) => {
                let mut out = a.clone();
                for (k, p) in b {
                    let merged = match a.get(k) {
                        Some(q) => q.combine(p),
                        None => p.clone(),
                    };
                    out.insert(k.clone(), merged);
                }
                Policy::Map(out)
            }
            _ => Policy::Conflict,
        }
    }

    /// `top` laid over `self`, a default: maps per key, anything else replaced.
    pub fn overlay(&self, top: &Policy) -> Policy {
        match (self, top) {
            (Policy::Map(a), Policy::Map(b)) => {
                let mut out = a.clone();
                for (k, p) in b {
                    let laid = match a.get(k) {
                        Some(q) => q.overlay(p),
                        None => p.clone(),
                    };
                    out.insert(k.clone(), laid);
                }
                Policy::Map(out)
            }
            (_, top) => top.clone(),
        }
    }
}

/// One step of a [`Conflict`]'s path: a map key, or the item of a list whose `by` field is `id`.
#[derive(Debug, Clone, PartialEq)]
pub enum Segment {
    Key(String),
    Item { by: String, id: Value },
}

/// A value both sides changed differently that no rule settled.
#[derive(Debug, Clone, PartialEq)]
pub struct Conflict {
    pub path: Vec<Segment>,
    pub base: Option<Value>,
    /// the side in the result
    pub kept: Option<Value>,
    /// the other side
    pub lost: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub value: Option<Value>,
    pub conflicts: Vec<Conflict>,
}

/// Merges `a` and `b` against `base` by `policy`.
pub fn merge(policy: &Policy, base: Option<&Value>, a: Option<&Value>, b: Option<&Value>) -> Outcome {
    let mut m = Merger { conflicts: Vec::new() };
    let value = m.at(policy, &mut Vec::new(), base, a, b);
    Outcome { value, conflicts: m.conflicts }
}

struct Merger {
    conflicts: Vec<Conflict>,
}

type Opt<'a> = Option<&'a Value>;

impl Merger {
    fn at(&mut self, policy: &Policy, path: &mut Vec<Segment>, b: Opt, l: Opt, r: Opt) -> Option<Value> {
        if l == r || r == b {
            // equal values may still differ in key order: take the canonical greater for symmetry
            return if l == r { max_side(l, r).cloned() } else { l.cloned() };
        }
        if l == b {
            return r.cloned();
        }
        match policy {
            Policy::Conflict => self.conflict(path, b, l, r),
            Policy::Map(keys) => match (l, r) {
                (Some(Value::Mapping(lm)), Some(Value::Mapping(rm))) => {
                    let empty = Mapping::new();
                    let bm = b.and_then(Value::as_mapping).unwrap_or(&empty);
                    let (first, second) = if cmp_side(l, r) == Ordering::Less { (rm, lm) } else { (lm, rm) };
                    let mut out = Mapping::new();
                    let ks: Vec<Value> = first.keys().chain(second.keys().filter(|k| !first.contains_key(*k))).cloned().collect();
                    let default = Policy::map();
                    for k in ks {
                        let sub = k.as_str().and_then(|k| keys.get(k)).unwrap_or(&default);
                        path.push(Segment::Key(k.as_str().map_or_else(|| canonical(&k), str::to_owned)));
                        let v = self.at(sub, path, bm.get(&k), lm.get(&k), rm.get(&k));
                        path.pop();
                        if let Some(v) = v {
                            out.insert(k, v);
                        }
                    }
                    Some(Value::Mapping(out))
                }
                _ => self.conflict(path, b, l, r),
            },
            Policy::Set => match (items(b), items(l), items(r)) {
                (Some(bi), Some(li), Some(ri)) => {
                    let (first, second) = if cmp_side(l, r) == Ordering::Less { (ri, li) } else { (li, ri) };
                    let mut out: Vec<Value> = Vec::new();
                    for i in first.iter().chain(second) {
                        let removed = bi.contains(i) && !(li.contains(i) && ri.contains(i));
                        if !removed && !out.contains(i) {
                            out.push(i.clone());
                        }
                    }
                    if out.is_empty() && (l.is_none() || r.is_none()) { None } else { Some(Value::Sequence(out)) }
                }
                _ => self.conflict(path, b, l, r),
            },
            Policy::UnionBy(field) => match (by_id(field, b), by_id(field, l), by_id(field, r)) {
                (Some(bi), Some(li), Some(ri)) => {
                    let mut ids: Vec<&Value> = li.iter().map(|(id, _)| *id).collect();
                    for (id, _) in &ri {
                        if !ids.contains(id) {
                            ids.push(id);
                        }
                    }
                    ids.sort_by(|x, y| cmp_values(x, y).then_with(|| canonical(x).cmp(&canonical(y))));
                    let item = Policy::map();
                    let mut out = Vec::new();
                    for id in ids {
                        path.push(Segment::Item { by: field.clone(), id: id.clone() });
                        let (bv, lv, rv) = (find(&bi, id), find(&li, id), find(&ri, id));
                        // append-only: an item missing on one side is kept, not removed
                        let v = match (lv, rv) {
                            (Some(_), None) => lv.cloned(),
                            (None, Some(_)) => rv.cloned(),
                            _ => self.at(&item, path, bv, lv, rv),
                        };
                        path.pop();
                        out.extend(v);
                    }
                    Some(Value::Sequence(out))
                }
                _ => self.conflict(path, b, l, r),
            },
            Policy::ListBy { field, item } => match (by_id(field, b), by_id(field, l), by_id(field, r)) {
                (Some(bi), Some(li), Some(ri)) => {
                    let (first, second) = if cmp_side(l, r) == Ordering::Less { (&ri, &li) } else { (&li, &ri) };
                    let mut ids: Vec<&Value> = first.iter().map(|(id, _)| *id).collect();
                    for (id, _) in second {
                        if !ids.contains(id) {
                            ids.push(id);
                        }
                    }
                    let mut out = Vec::new();
                    for id in ids {
                        path.push(Segment::Item { by: field.clone(), id: id.clone() });
                        let v = self.at(item, path, find(&bi, id), find(&li, id), find(&ri, id));
                        path.pop();
                        out.extend(v);
                    }
                    if out.is_empty() && (l.is_none() || r.is_none()) { None } else { Some(Value::Sequence(out)) }
                }
                _ => self.conflict(path, b, l, r),
            },
            Policy::Text => match (l, r) {
                (Some(Value::String(ls)), Some(Value::String(rs))) => {
                    let bs = b.and_then(Value::as_str).unwrap_or("");
                    match (diffy::merge(bs, ls, rs), diffy::merge(bs, rs, ls)) {
                        (Ok(x), Ok(y)) => Some(Value::String(x.max(y))),
                        _ => self.conflict(path, b, l, r),
                    }
                }
                _ => self.conflict(path, b, l, r),
            },
            Policy::NewestBy(paths) => {
                for p in paths {
                    match cmp_opt(get_path(l, p), get_path(r, p)) {
                        Ordering::Greater => return l.cloned(),
                        Ordering::Less => return r.cloned(),
                        Ordering::Equal => {}
                    }
                }
                self.conflict(path, b, l, r)
            }
            Policy::Max | Policy::Min => match (l, r) {
                (Some(x), Some(y)) => match cmp_values(x, y) {
                    Ordering::Equal => self.conflict(path, b, l, r),
                    o => {
                        let greater = if o == Ordering::Greater { x } else { y };
                        let smaller = if o == Ordering::Greater { y } else { x };
                        Some(if *policy == Policy::Max { greater } else { smaller }.clone())
                    }
                },
                // a missing value doesn't count
                _ => l.or(r).cloned(),
            },
        }
    }

    fn conflict(&mut self, path: &[Segment], b: Opt, l: Opt, r: Opt) -> Option<Value> {
        let (kept, lost) = if cmp_side(l, r) == Ordering::Less { (r, l) } else { (l, r) };
        self.conflicts.push(Conflict { path: path.to_vec(), base: b.cloned(), kept: kept.cloned(), lost: lost.cloned() });
        kept.cloned()
    }
}

fn items(v: Opt<'_>) -> Option<&[Value]> {
    match v {
        None | Some(Value::Null) => Some(&[]),
        Some(Value::Sequence(s)) => Some(s),
        Some(_) => None,
    }
}

/// A list's items by their `field`; `None` when it isn't a list, or an item lacks the field or repeats an id.
fn by_id<'a>(field: &str, v: Opt<'a>) -> Option<Vec<(&'a Value, &'a Value)>> {
    let mut out: Vec<(&Value, &Value)> = Vec::new();
    for i in items(v)? {
        let id = i.as_mapping()?.get(field)?;
        if out.iter().any(|(x, _)| *x == id) {
            return None;
        }
        out.push((id, i));
    }
    Some(out)
}

fn find<'a>(items: &[(&'a Value, &'a Value)], id: &Value) -> Opt<'a> {
    items.iter().find(|(x, _)| *x == id).map(|(_, v)| *v)
}

fn get_path<'a>(v: Opt<'a>, path: &[String]) -> Opt<'a> {
    path.iter().try_fold(v?, |v, k| v.as_mapping()?.get(k.as_str()))
}

/// Numbers by value, strings (ISO datetimes too) by text, anything else by its canonical form.
fn cmp_values(a: &Value, b: &Value) -> Ordering {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64().partial_cmp(&y.as_f64()).unwrap_or(Ordering::Equal),
        (Value::String(x), Value::String(y)) => x.cmp(y),
        _ => canonical(a).cmp(&canonical(b)),
    }
}

/// `None` and null first.
fn cmp_opt(a: Opt, b: Opt) -> Ordering {
    let a = a.filter(|v| !v.is_null());
    let b = b.filter(|v| !v.is_null());
    match (a, b) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Less,
        (Some(_), None) => Ordering::Greater,
        (Some(x), Some(y)) => cmp_values(x, y),
    }
}

/// The tiebreak: `None` first, then by canonical form.
fn cmp_side(a: Opt, b: Opt) -> Ordering {
    match (a, b) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Less,
        (Some(_), None) => Ordering::Greater,
        (Some(x), Some(y)) => canonical(x).cmp(&canonical(y)),
    }
}

fn max_side<'a>(a: Opt<'a>, b: Opt<'a>) -> Opt<'a> {
    if cmp_side(a, b) == Ordering::Less { b } else { a }
}

/// A value as text, with map keys sorted, so equal values (in any key order) read the same.
pub fn canonical(v: &Value) -> String {
    let mut s = String::new();
    write_canonical(v, &mut s);
    s
}

fn write_canonical(v: &Value, s: &mut String) {
    match v {
        Value::Null => s.push('~'),
        Value::Bool(b) => s.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => s.push_str(&n.to_string()),
        Value::String(t) => s.push_str(&format!("{t:?}")),
        Value::Sequence(items) => {
            s.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    s.push(',');
                }
                write_canonical(item, s);
            }
            s.push(']');
        }
        Value::Mapping(m) => {
            let mut entries: Vec<(String, String)> = m.iter().map(|(k, v)| (canonical(k), canonical(v))).collect();
            entries.sort();
            s.push('{');
            for (i, (k, v)) in entries.iter().enumerate() {
                if i > 0 {
                    s.push(',');
                }
                s.push_str(k);
                s.push(':');
                s.push_str(v);
            }
            s.push('}');
        }
        Value::Tagged(t) => {
            s.push_str(&t.tag.to_string());
            s.push(' ');
            write_canonical(&t.value, s);
        }
    }
}

#[cfg(test)]
mod tests;
