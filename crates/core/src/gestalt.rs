//! Gestalts: the versioned shapes a yml can have (`gestalts/<name>/v<N>.yml`).
//!
//! Every yml names exactly one gestalt, as `gestalt: name@N`, and is judged by that definition alone. Definitions are
//! closed: a prop the definition doesn't declare makes the yml invalid. Nothing is ever inferred from a yml's content.

use std::collections::{BTreeMap, HashMap};

use gestalts_merge::Policy;
use serde::{Deserialize, Serialize};
use serde_yaml_ng::{Mapping, Value};

use crate::merge::is_tombstone;
use crate::yml::{Yml, valid_key};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GestaltDef {
    pub name: String,
    pub version: u32,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub fields: BTreeMap<String, FieldRule>,
    /// how its ymls merge in sync, over what the field types imply (`gestalts_merge::Policy::parse`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FieldRule {
    #[serde(rename = "type", default)]
    pub ty: FieldType,
    #[serde(default)]
    pub required: bool,
    /// numeric bounds (inclusive), item count bounds for lists, value bounds for `ref_map`
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub one_of: Option<Vec<Value>>,
    /// for `type: map`
    #[serde(default)]
    pub fields: BTreeMap<String, FieldRule>,
    /// for `type: list`: the rule every item follows
    #[serde(default)]
    pub items: Option<Box<FieldRule>>,
    /// for `type: map`: the rule every value follows
    #[serde(default)]
    pub values: Option<Box<FieldRule>>,
    /// for reference types: the gestalt names a target may have; empty allows any
    #[serde(default)]
    pub targets: Vec<String>,
    /// for `relationships` and `blobs`: how many items each label may have
    #[serde(default)]
    pub labels: BTreeMap<String, Count>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FieldType {
    #[default]
    Any,
    /// single-line string
    String,
    /// any string, usually multi-line; `![[blob]]` embeds in it count as uses of that blob
    Text,
    Number,
    Integer,
    Bool,
    /// `YYYY-MM-DD`
    Date,
    /// `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, or a range of two of them joined by `/` (either side may be open)
    PartialDate,
    /// ISO 8601 `YYYY-MM-DDTHH:MM...`
    Datetime,
    Url,
    StringList,
    /// a list; `items` checks each element
    List,
    Map,
    /// the name of a blob
    Blob,
    /// the id of a yml
    Ref,
    /// ids of ymls
    RefList,
    /// `{id: number}`
    RefMap,
    /// `[{to: id, label: text}]`
    Relationships,
    /// `[{file: blob name, label: text}]`
    Blobs,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Count {
    #[serde(default)]
    pub min: Option<usize>,
    #[serde(default)]
    pub max: Option<usize>,
}

/// Something wrong with a yml.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Problem {
    /// e.g. `card.dueAt`; empty for the yml as a whole
    pub path: String,
    pub message: String,
}

/// What a yml is, given the definitions this device has.
#[derive(Debug, Clone, PartialEq)]
pub enum YmlState {
    /// conforms to the gestalt it names
    Valid(String),
    /// `{id, deleted}`
    Tombstone,
    /// well-formed, naming a gestalt this device has no definition for: synced, not queryable
    Unknown(String),
    /// synced byte for byte, never queryable; reported by the health report
    Invalid(Vec<Problem>),
}

/// A reference from one yml to another.
#[derive(Debug, Clone, PartialEq)]
pub struct Edge {
    /// the top-level prop holding it
    pub field: String,
    pub target: String,
    /// the gestalt names the target may have; empty allows any
    pub targets: Vec<String>,
}

fn whole(message: impl Into<String>) -> Vec<Problem> {
    vec![Problem { path: String::new(), message: message.into() }]
}

/// `name@N`, `N` from 1, with no leading zero.
fn valid_gestalt_id(s: &str) -> bool {
    let Some((name, version)) = s.split_once('@') else { return false };
    let name_ok = !name.is_empty() && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    let version_ok = !version.is_empty() && !version.starts_with('0') && version.bytes().all(|b| b.is_ascii_digit());
    name_ok && version_ok
}

/// Calls `visit` for a value and everything nested in it that its rule describes.
fn walk<'a>(v: &'a Value, rule: &'a FieldRule, visit: &mut dyn FnMut(&'a Value, &'a FieldRule)) {
    visit(v, rule);
    match v {
        Value::Mapping(m) => {
            for (k, r) in &rule.fields {
                if let Some(item) = m.get(k.as_str()) {
                    walk(item, r, visit);
                }
            }
            if let Some(r) = &rule.values {
                m.values().for_each(|item| walk(item, r, visit));
            }
        }
        Value::Sequence(items) => {
            if let Some(r) = &rule.items {
                items.iter().for_each(|item| walk(item, r, visit));
            }
        }
        _ => {}
    }
}

/// The string at `key` of each item of a labelled list.
fn labelled<'a>(v: &'a Value, key: &str) -> impl Iterator<Item = &'a str> {
    v.as_sequence().into_iter().flatten().filter_map(move |item| item.get(key)?.as_str())
}

impl GestaltDef {
    pub fn id(&self) -> String {
        format!("{}@{}", self.name, self.version)
    }

    /// How this gestalt's ymls merge: lists of references and text by what their type implies, with its `merge:` rules
    /// laid over that. Definitions are validated on load, so a broken `merge:` can't reach here.
    pub fn policy(&self) -> Policy {
        let keys = self
            .fields
            .iter()
            .filter_map(|(k, r)| match r.ty {
                FieldType::Text => Some((k.clone(), Policy::Text)),
                FieldType::StringList | FieldType::RefList | FieldType::Relationships | FieldType::Blobs => Some((k.clone(), Policy::Set)),
                _ => None,
            })
            .collect();
        let implied = Policy::Map(keys);
        match self.merge.as_ref().and_then(|m| Policy::parse(m).ok()) {
            Some(declared) => implied.overlay(&declared),
            None => implied,
        }
    }

    /// Everything wrong with `m` by this definition.
    fn check(&self, m: &Mapping) -> Vec<Problem> {
        let mut problems = Vec::new();
        let mut report = |path: String, message: String| problems.push(Problem { path, message });
        for k in m.keys() {
            let known = k.as_str().is_some_and(|k| matches!(k, "id" | "gestalt") || self.fields.contains_key(k));
            if !known {
                report(k.as_str().unwrap_or("?").to_owned(), format!("is not a prop of {}", self.id()));
            }
        }
        for (field, rule) in &self.fields {
            check_field(field, m.get(field.as_str()), rule, &mut report);
        }
        problems
    }

    fn each_field<'a>(&'a self, m: &'a Mapping, visit: &mut dyn FnMut(&'a str, &'a Value, &'a FieldRule)) {
        for (field, rule) in &self.fields {
            if let Some(v) = m.get(field.as_str()) {
                walk(v, rule, &mut |v, r| visit(field, v, r));
            }
        }
    }

    /// The references a yml of this gestalt holds.
    pub fn edges(&self, m: &Mapping) -> Vec<Edge> {
        let mut out = Vec::new();
        self.each_field(m, &mut |field, v, r| {
            let mut add = |target: &str| out.push(Edge { field: field.to_owned(), target: target.to_owned(), targets: r.targets.clone() });
            match r.ty {
                FieldType::Ref => v.as_str().into_iter().for_each(&mut add),
                FieldType::RefList => v.as_sequence().into_iter().flatten().filter_map(Value::as_str).for_each(&mut add),
                FieldType::RefMap => v.as_mapping().into_iter().flat_map(Mapping::keys).filter_map(Value::as_str).for_each(&mut add),
                FieldType::Relationships => labelled(v, "to").for_each(&mut add),
                _ => {}
            }
        });
        out
    }

    /// The blob names a yml of this gestalt may use. `any` values could hold anything, so every string in one counts.
    pub fn blob_names(&self, m: &Mapping) -> Vec<String> {
        let mut out = Vec::new();
        self.each_field(m, &mut |_, v, r| match r.ty {
            FieldType::Blob => out.extend(v.as_str().map(str::to_owned)),
            FieldType::Blobs => out.extend(labelled(v, "file").map(str::to_owned)),
            FieldType::Text => out.extend(v.as_str().map(crate::blobs::embeds).unwrap_or_default()),
            FieldType::Any => crate::blobs::scan(v, &mut out),
            _ => {}
        });
        out
    }

    /// The text a yml of this gestalt can be found by.
    pub fn searchable<'a>(&'a self, m: &'a Mapping) -> Vec<&'a str> {
        let mut out = Vec::new();
        self.each_field(m, &mut |_, v, r| match r.ty {
            FieldType::String | FieldType::Text => out.extend(v.as_str()),
            FieldType::StringList => out.extend(v.as_sequence().into_iter().flatten().filter_map(Value::as_str)),
            _ => {}
        });
        out
    }
}

fn check_field(path: &str, v: Option<&Value>, rule: &FieldRule, report: &mut impl FnMut(String, String)) {
    let Some(v) = v.filter(|v| !v.is_null()) else {
        if rule.required {
            report(path.into(), "is required".into());
        }
        return;
    };
    let is_id = |v: &Value| v.as_str().is_some_and(valid_key);
    let is_labelled = |v: &Value, key: &str| {
        v.as_sequence().is_some_and(|items| {
            items.iter().all(|i| {
                i.as_mapping().is_some_and(|m| m.len() == 2) && i.get(key).is_some_and(is_id) && i.get("label").is_some_and(|l| l.as_str().is_some_and(|l| !l.is_empty()))
            })
        })
    };
    let ok = match rule.ty {
        FieldType::Any => true,
        FieldType::String => v.as_str().is_some_and(|s| !s.contains('\n')),
        FieldType::Text => v.is_string(),
        FieldType::Number => v.is_number(),
        FieldType::Integer => v.is_i64() || v.is_u64(),
        FieldType::Bool => v.is_bool(),
        FieldType::Date => v.as_str().is_some_and(is_date),
        FieldType::PartialDate => v.as_str().is_some_and(is_partial_date_range),
        FieldType::Datetime => v.as_str().is_some_and(is_datetime),
        FieldType::Url => v.as_str().is_some_and(is_url),
        FieldType::StringList => v.as_sequence().is_some_and(|s| s.iter().all(Value::is_string)),
        FieldType::List => v.is_sequence(),
        FieldType::Map => v.is_mapping(),
        FieldType::Blob | FieldType::Ref => is_id(v),
        FieldType::RefList => v.as_sequence().is_some_and(|s| s.iter().all(is_id)),
        FieldType::RefMap => v.as_mapping().is_some_and(|m| m.iter().all(|(k, n)| is_id(k) && n.is_number())),
        FieldType::Relationships => is_labelled(v, "to"),
        FieldType::Blobs => is_labelled(v, "file"),
    };
    if !ok {
        report(path.into(), format!("must be {}", type_name(rule.ty)));
        return;
    }
    let bounded = |n: f64, path: String, report: &mut dyn FnMut(String, String)| {
        if let Some(min) = rule.min.filter(|min| n < *min) {
            report(path.clone(), format!("must be at least {min}"));
        }
        if let Some(max) = rule.max.filter(|max| n > *max) {
            report(path, format!("must be at most {max}"));
        }
    };
    match v {
        Value::Number(n) => bounded(n.as_f64().unwrap_or_default(), path.into(), report),
        Value::Sequence(s) => bounded(s.len() as f64, path.into(), report),
        Value::Mapping(m) if rule.ty == FieldType::RefMap => {
            for (k, n) in m {
                bounded(n.as_f64().unwrap_or_default(), format!("{path}.{}", k.as_str().unwrap_or("?")), report);
            }
        }
        _ => {}
    }
    if let Some(options) = rule.one_of.as_ref().filter(|o| !o.contains(v)) {
        let shown: Vec<String> = options.iter().map(|o| crate::yml::to_yaml(o).trim().to_owned()).collect();
        report(path.into(), format!("must be one of {}", shown.join(", ")));
    }
    for (label, count) in &rule.labels {
        let n = labelled(v, "label").filter(|l| l == label).count();
        if count.min.is_some_and(|min| n < min) || count.max.is_some_and(|max| n > max) {
            report(format!("{path}.{label}"), format!("has {n} `{label}`, which is outside its allowed count"));
        }
    }
    if let Value::Mapping(m) = v {
        for (sub, sub_rule) in &rule.fields {
            check_field(&format!("{path}.{sub}"), m.get(sub.as_str()), sub_rule, report);
        }
        if let Some(value_rule) = &rule.values {
            for (k, item) in m {
                check_field(&format!("{path}.{}", k.as_str().unwrap_or("?")), Some(item), value_rule, report);
            }
        }
    }
    if let (Value::Sequence(items), Some(item_rule)) = (v, &rule.items) {
        for (i, item) in items.iter().enumerate() {
            check_field(&format!("{path}.{i}"), Some(item), item_rule, report);
        }
    }
}

/// Keys of a rule that only make sense for some types; anything else is a mistake in the definition.
fn check_rule(path: &str, rule: &FieldRule) -> Result<(), String> {
    use FieldType::{Blobs, List, Map, Ref, RefList, RefMap, Relationships};
    if rule.items.is_some() && rule.ty != List {
        return Err(format!("{path}: `items` needs `type: list`"));
    }
    if !rule.fields.is_empty() && rule.ty != Map {
        return Err(format!("{path}: `fields` needs `type: map`"));
    }
    if rule.values.is_some() && rule.ty != Map {
        return Err(format!("{path}: `values` needs `type: map`"));
    }
    if !rule.targets.is_empty() && !matches!(rule.ty, Ref | RefList | RefMap | Relationships) {
        return Err(format!("{path}: `targets` needs a reference type"));
    }
    if !rule.labels.is_empty() && !matches!(rule.ty, Relationships | Blobs) {
        return Err(format!("{path}: `labels` needs `type: relationships` or `type: blobs`"));
    }
    if let Some(r) = &rule.values {
        check_rule(&format!("{path}{{}}"), r)?;
    }
    for (sub, r) in &rule.fields {
        check_rule(&format!("{path}.{sub}"), r)?;
    }
    if let Some(r) = &rule.items {
        check_rule(&format!("{path}[]"), r)?;
    }
    Ok(())
}

fn type_name(t: FieldType) -> &'static str {
    match t {
        FieldType::Any => "anything",
        FieldType::String => "a single-line string",
        FieldType::Text => "a string",
        FieldType::Number => "a number",
        FieldType::Integer => "an integer",
        FieldType::Bool => "true or false",
        FieldType::Date => "a date (YYYY-MM-DD)",
        FieldType::PartialDate => "a date (YYYY, YYYY-MM or YYYY-MM-DD, or a range a/b)",
        FieldType::Datetime => "a datetime (YYYY-MM-DDTHH:MM…)",
        FieldType::Url => "a URL",
        FieldType::StringList => "a list of strings",
        FieldType::List => "a list",
        FieldType::Map => "a map",
        FieldType::Blob => "a blob name",
        FieldType::Ref => "an id",
        FieldType::RefList => "a list of ids",
        FieldType::RefMap => "a map of ids to numbers",
        FieldType::Relationships => "a list of {to, label}",
        FieldType::Blobs => "a list of {file, label}",
    }
}

fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let num = |r: std::ops::Range<usize>| s[r].parse::<u32>().ok();
    matches!((num(0..4), num(5..7), num(8..10)), (Some(_), Some(m @ 1..=12), Some(d @ 1..=31)) if m > 0 && d > 0)
}

fn is_partial_date(s: &str) -> bool {
    let b = s.as_bytes();
    let year = |r: std::ops::Range<usize>| s.get(r).is_some_and(|y| y.len() == 4 && y.bytes().all(|c| c.is_ascii_digit()));
    match b.len() {
        4 => year(0..4),
        7 => year(0..4) && b[4] == b'-' && s[5..7].parse::<u32>().is_ok_and(|m| (1..=12).contains(&m)),
        10 => is_date(s),
        _ => false,
    }
}

fn is_partial_date_range(s: &str) -> bool {
    match s.split_once('/') {
        None => is_partial_date(s),
        Some((a, b)) => (a.is_empty() || is_partial_date(a)) && (b.is_empty() || is_partial_date(b)) && !(a.is_empty() && b.is_empty()),
    }
}

fn is_datetime(s: &str) -> bool {
    s.len() >= 16 && is_date(&s[..10]) && s.as_bytes()[10] == b'T' && s[11..13].parse::<u32>().is_ok_and(|h| h < 24)
}

fn is_url(s: &str) -> bool {
    let rest = s.strip_prefix("https://").or_else(|| s.strip_prefix("http://"));
    rest.is_some_and(|r| {
        let host = r.split(['/', '?', '#']).next().unwrap_or("");
        !host.is_empty() && !r.contains(char::is_whitespace)
    })
}

/// All known gestalt definitions.
#[derive(Debug, Clone)]
pub struct Gestalts {
    defs: Vec<GestaltDef>,
    by_id: HashMap<String, usize>,
}

/// The definitions shipped in `gestalts/`, embedded at build time.
const BUILTIN: &[&str] = &[
    include_str!("../../../gestalts/note/v1.yml"),
    include_str!("../../../gestalts/concept/v1.yml"),
    include_str!("../../../gestalts/concept-practice-event/v1.yml"),
    include_str!("../../../gestalts/flashcard/v1.yml"),
    include_str!("../../../gestalts/source/v1.yml"),
    include_str!("../../../gestalts/deck/v1.yml"),
    include_str!("../../../gestalts/fsrs-data/v1.yml"),
    include_str!("../../../gestalts/practice-session/v1.yml"),
    include_str!("../../../gestalts/plugin-install/v1.yml"),
    include_str!("../../../gestalts/view/v1.yml"),
    include_str!("../../../gestalts/conflict/v1.yml"),
];

impl Gestalts {
    pub fn builtin() -> Self {
        Self::builtin_with(&[]).expect("builtin gestalts are valid")
    }

    /// The core's gestalts plus `extra` (a plugin's, loaded at runtime). Fails on a broken definition, or one that
    /// redefines a gestalt.
    pub fn builtin_with(extra: &[&str]) -> Result<Self, String> {
        let mut all: Vec<&str> = BUILTIN.to_vec();
        all.extend_from_slice(extra);
        Self::from_yaml(&all)
    }

    pub fn from_yaml(sources: &[&str]) -> Result<Self, String> {
        let defs = sources.iter().map(|s| serde_yaml_ng::from_str::<GestaltDef>(s).map_err(|e| e.to_string())).collect::<Result<Vec<_>, _>>()?;
        let mut by_id = HashMap::new();
        for (i, d) in defs.iter().enumerate() {
            if !valid_gestalt_id(&d.id()) {
                return Err(format!("{}: not a valid gestalt id", d.id()));
            }
            for (field, rule) in &d.fields {
                if matches!(field.as_str(), "id" | "gestalt") {
                    return Err(format!("{}: `{field}` belongs to every yml and can't be declared", d.id()));
                }
                check_rule(field, rule).map_err(|e| format!("{}: {e}", d.id()))?;
            }
            if let Some(m) = &d.merge {
                Policy::parse(m).map_err(|e| format!("{}: merge: {e}", d.id()))?;
            }
            if by_id.insert(d.id(), i).is_some() {
                return Err(format!("{} is defined twice", d.id()));
            }
        }
        Ok(Gestalts { defs, by_id })
    }

    pub fn defs(&self) -> &[GestaltDef] {
        &self.defs
    }

    /// by `name@version`
    pub fn get(&self, id: &str) -> Option<&GestaltDef> {
        self.by_id.get(id).map(|&i| &self.defs[i])
    }

    /// What `yml` is. There are no defaults: a yml that doesn't say what it is, is invalid.
    pub fn classify(&self, yml: &Yml) -> YmlState {
        if let Some(e) = &yml.parse_error {
            return YmlState::Invalid(whole(format!("doesn't parse: {}", e.message)));
        }
        let Some(m) = yml.map() else { return YmlState::Invalid(whole("is not a map")) };
        match m.get("id").and_then(Value::as_str) {
            Some(id) if id == yml.id => {}
            Some(id) => return YmlState::Invalid(whole(format!("id `{id}` doesn't match its file name `{}`", yml.id))),
            None => return YmlState::Invalid(whole("has no id")),
        }
        if yml.value.as_ref().is_some_and(is_tombstone) {
            return YmlState::Tombstone;
        }
        let Some(gestalt) = yml.gestalt() else { return YmlState::Invalid(whole("has no gestalt")) };
        if !valid_gestalt_id(gestalt) {
            return YmlState::Invalid(whole(format!("`{gestalt}` is not name@version")));
        }
        let Some(def) = self.get(gestalt) else { return YmlState::Unknown(gestalt.to_owned()) };
        let problems = def.check(m);
        if problems.is_empty() { YmlState::Valid(gestalt.to_owned()) } else { YmlState::Invalid(problems) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::yml::parse_yaml;

    fn state(id: &str, raw: &str) -> YmlState {
        Gestalts::builtin().classify(&Yml::parse(id, raw))
    }

    fn invalid(id: &str, raw: &str) -> String {
        match state(id, raw) {
            YmlState::Invalid(p) => format!("{p:?}"),
            other => panic!("{raw}: expected invalid, got {other:?}"),
        }
    }

    #[test]
    fn every_shipped_definition_is_loaded() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../gestalts");
        let files = std::fs::read_dir(dir).unwrap().flat_map(|d| std::fs::read_dir(d.unwrap().path()).unwrap()).count();
        assert_eq!(files, BUILTIN.len(), "a file in gestalts/ isn't listed in BUILTIN");
        assert_eq!(Gestalts::builtin().defs().len(), BUILTIN.len());
    }

    #[test]
    fn a_note_needs_only_id_and_gestalt() {
        assert_eq!(state("a", "id: a\ngestalt: note@1\n"), YmlState::Valid("note@1".into()));
    }

    #[test]
    fn nothing_is_defaulted() {
        assert!(invalid("a", "id: a\ntitle: x\n").contains("no gestalt"));
        assert!(invalid("a", "title: x\ngestalt: note@1\n").contains("no id"));
        assert!(invalid("a", "").contains("no id"));
        assert!(invalid("a", "id: b\ngestalt: note@1\n").contains("doesn't match"));
        assert!(invalid("a", "id: a\ngestalt: note\n").contains("name@version"));
        assert!(invalid("a", "id: a\ngestalt: note@01\n").contains("name@version"));
        assert!(invalid("a", "just text").contains("not a map"));
        assert!(invalid("a", "a: [x").contains("parse"));
    }

    #[test]
    fn definitions_are_closed() {
        assert!(invalid("a", "id: a\ngestalt: note@1\nfront: x\n").contains("not a prop of note@1"));
    }

    #[test]
    fn tombstones_and_unknown_gestalts() {
        assert_eq!(state("a", "id: a\ndeleted: 2026-01-01T00:00:00Z\n"), YmlState::Tombstone);
        invalid("a", "id: b\ndeleted: 2026-01-01T00:00:00Z\n");
        assert_eq!(state("a", "id: a\ngestalt: from-a-plugin@3\nanything: 1\n"), YmlState::Unknown("from-a-plugin@3".into()));
    }

    #[test]
    fn relationships_and_blobs_are_labelled() {
        assert!(matches!(state("a", "id: a\ngestalt: note@1\nrelationships: [{to: b, label: see}]\nblobs: [{file: x.png, label: pic}]\n"), YmlState::Valid(_)));
        invalid("a", "id: a\ngestalt: note@1\nrelationships: [b]\n");
        invalid("a", "id: a\ngestalt: note@1\nrelationships: [{to: b}]\n");
        invalid("a", "id: a\ngestalt: note@1\nblobs: [x.png]\n");
    }

    #[test]
    fn a_concept_has_a_name_and_no_practicers() {
        assert!(matches!(state("c", "id: c\ngestalt: concept@1\nname: 'grc:θ'\nparents: [p]\nchildren: []\n"), YmlState::Valid(_)));
        assert!(invalid("c", "id: c\ngestalt: concept@1\nname: x\npracticed-by: {e1: 1}\n").contains("not a prop of concept@1"));
        invalid("c", "id: c\ngestalt: concept@1\n");
    }

    #[test]
    fn a_flashcard_practices_concepts_from_0_to_1() {
        let ok = "id: f\ngestalt: flashcard@1\nfront: q\nback: a\ntags: [t]\naliases: [x]\nblobs: [{file: a.png, label: front}, {file: b.mp3, label: audio}]\nconcepts: {c1: 0.25, c2: 1}\n";
        assert!(matches!(state("f", ok), YmlState::Valid(_)));
        assert!(matches!(state("f", "id: f\ngestalt: flashcard@1\nfront: q\n"), YmlState::Valid(_)));
        invalid("f", "id: f\ngestalt: flashcard@1\nback: a\n");
        assert!(invalid("f", "id: f\ngestalt: flashcard@1\nfront: q\nconcepts: {c1: 1.5}\n").contains("concepts.c1"));
        invalid("f", "id: f\ngestalt: flashcard@1\nfront: q\nblobs: [{file: a.png, label: front}, {file: b.png, label: front}]\n");
    }

    #[test]
    fn a_source_is_a_biblatex_entry_with_ordered_names() {
        let ok = "id: s\ngestalt: source@1\nkey: doe2020\nentrytype: article\ntitle: On magnets\nauthor: ['Doe, Jane', 'van Rossum, Guido', ACM]\ndate: 2020-05\nvolume: 12\npages: 1--10\ndoi: 10.1/x\nurl: https://example.org/a\naliases: [the weird magnet paper]\nblobs: [{file: a.pdf, label: pdf}]\n";
        assert!(matches!(state("s", ok), YmlState::Valid(_)));
        assert!(matches!(state("s", "id: s\ngestalt: source@1\nkey: k\nentrytype: misc\n"), YmlState::Valid(_)));
        invalid("s", "id: s\ngestalt: source@1\nentrytype: misc\n");
        assert!(invalid("s", "id: s\ngestalt: source@1\nkey: k\nentrytype: blogpost\n").contains("entrytype"));
        assert!(invalid("s", "id: s\ngestalt: source@1\nkey: k\nentrytype: misc\nauthor: [{family: Doe}]\n").contains("author"));
        assert!(invalid("s", "id: s\ngestalt: source@1\nkey: k\nentrytype: misc\njournal: X\n").contains("not a prop of source@1"));

        let def = Gestalts::builtin().get("source@1").unwrap().clone();
        let y = Yml::parse("s", ok);
        let found = def.searchable(y.map().unwrap());
        for s in ["On magnets", "Doe, Jane", "the weird magnet paper", "10.1/x"] {
            assert!(found.contains(&s), "{s} in {found:?}");
        }
        // names keep their order: two different edits conflict rather than mixing into a set
        let v = |s: &str| parse_yaml(s).unwrap();
        let (base, a, b) = (v("{author: [A, B]}"), v("{author: [B, A]}"), v("{author: [A, B, C]}"));
        let out = gestalts_merge::merge(&def.policy(), Some(&base), Some(&a), Some(&b));
        assert_eq!(out.conflicts.len(), 1);
    }

    #[test]
    fn a_note_relates_to_a_source() {
        let g = Gestalts::builtin();
        let n = Yml::parse("n", "id: n\ngestalt: note@1\nmain: magnets attract\nrelationships: [{to: s, label: source p. 3}]\n");
        let edges = g.get("note@1").unwrap().edges(n.map().unwrap());
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].targets, vec!["note", "source"]);
    }

    #[test]
    fn a_practice_event_rates_from_minus_2_to_2() {
        let event = |rating: &str| format!("id: e\ngestalt: concept-practice-event@1\nconcept: c\norigin: f\nat: 2026-11-01T12:00:00Z\nrating: {rating}\n");
        for ok in ["-2", "-1", "0", "1", "2"] {
            assert!(matches!(state("e", &event(ok)), YmlState::Valid(_)), "{ok}");
        }
        invalid("e", &event("3"));
        invalid("e", "id: e\ngestalt: concept-practice-event@1\nconcept: c\nat: 2026-11-01T12:00:00Z\nrating: 0\n");
    }

    #[test]
    fn edges_blobs_and_text() {
        let g = Gestalts::builtin();
        let c = Yml::parse("f", "id: f\ngestalt: flashcard@1\nfront: q\nconcepts: {p: 0.5}\n");
        let edges = g.get("flashcard@1").unwrap().edges(c.map().unwrap());
        assert_eq!(edges.iter().map(|e| (e.field.as_str(), e.target.as_str())).collect::<Vec<_>>(), vec![("concepts", "p")]);
        assert_eq!(edges[0].targets, vec!["concept"]);
        let n = Yml::parse("n", "id: n\ngestalt: note@1\ntitle: T\nmain: see ![[a.png]]\ntags: [z]\nblobs: [{file: b.png, label: pic}]\n");
        let def = g.get("note@1").unwrap();
        let mut blobs = def.blob_names(n.map().unwrap());
        blobs.sort();
        assert_eq!(blobs, vec!["a.png", "b.png"]);
        assert_eq!(def.searchable(n.map().unwrap()), vec!["see ![[a.png]]", "z", "T"].into_iter().collect::<Vec<_>>());
    }

    #[test]
    fn broken_definitions_are_refused() {
        for bad in [
            "name: a\nversion: 1\nmerge: sometimes\n",
            "name: a\nversion: 1\nrequires_tags: [a]\n",
            "name: a\nversion: 1\nfields: { id: { type: string } }\n",
            "name: a\nversion: 1\nfields: { x: { type: string, targets: [note] } }\n",
            "name: A b\nversion: 1\n",
            "name: a\nversion: 0\n",
        ] {
            assert!(Gestalts::from_yaml(&[bad]).is_err(), "{bad}");
        }
        let twice = "name: a\nversion: 1\n";
        assert!(Gestalts::from_yaml(&[twice, twice]).is_err());
    }
}
