//! Gestalts: versioned, data-defined shapes a note may have (`gestalts/<name>/v<N>.yml`).
//!
//! A note is a *candidate* for a gestalt when it carries all `requires_tags` and, if
//! `trigger_fields` is set, at least one of them. A candidate *has* the gestalt when every rule
//! holds; otherwise the broken rules are reported as lints.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_yaml_ng::Value;

use crate::note::{Note, Ref};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GestaltDef {
    pub name: String,
    pub version: u32,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub requires_tags: Vec<String>,
    #[serde(default)]
    pub trigger_fields: Vec<String>,
    #[serde(default)]
    pub fields: BTreeMap<String, FieldRule>,
    /// by label; `_` counts unlabelled ones
    #[serde(default)]
    pub blobs: BTreeMap<String, Count>,
    #[serde(default)]
    pub relationships: BTreeMap<String, Count>,
    /// how its notes merge in sync (`gestalts_merge::Policy::parse`); validated on load
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
    /// numeric bounds (inclusive), or item count bounds for lists
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
    /// for `type: map`: the rule every value follows (for maps keyed by data, like typst `assets`)
    #[serde(default)]
    pub values: Option<Box<FieldRule>>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FieldType {
    #[default]
    Any,
    /// single-line string
    String,
    /// any string, usually multi-line
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
    /// the name of a blob; every blob a note uses this way must also be listed in its `blobs`
    Blob,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Count {
    #[serde(default)]
    pub min: Option<usize>,
    #[serde(default)]
    pub max: Option<usize>,
    /// for relationships: a note whose target is deleted is deleted too (learner state of a deleted card)
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub dies_with_target: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Lint {
    /// `name@version`
    pub gestalt: String,
    /// e.g. `fsrs.due`, `blobs.audio`
    pub path: String,
    pub message: String,
}

impl GestaltDef {
    pub fn id(&self) -> String {
        format!("{}@{}", self.name, self.version)
    }

    /// The `merge:` rules, if any. Definitions are validated on load, so a broken one can't reach here.
    pub fn merge_policy(&self) -> Option<gestalts_merge::Policy> {
        self.merge.as_ref().and_then(|m| gestalts_merge::Policy::parse(m).ok())
    }

    pub fn is_candidate(&self, note: &Note) -> bool {
        self.requires_tags.iter().all(|t| note.has_tag(t))
            && (self.trigger_fields.is_empty() || self.trigger_fields.iter().any(|f| note.get(f).is_some()))
    }

    /// `None`: not a candidate. `Some([])`: the note has this gestalt.
    pub fn check(&self, note: &Note) -> Option<Vec<Lint>> {
        if !self.is_candidate(note) {
            return None;
        }
        let mut lints = Vec::new();
        let mut lint = |path: String, message: String| lints.push(Lint { gestalt: self.id(), path, message });
        if note.value.as_ref().is_none_or(|v| !v.is_mapping()) {
            lint(String::new(), "note is not a YAML map".into());
            return Some(lints);
        }
        for (field, rule) in &self.fields {
            check_field(field, note.get(field), rule, &mut lint);
        }
        check_counts("blobs", &note.blobs(), &self.blobs, &mut lint);
        check_counts("relationships", &note.relationships(), &self.relationships, &mut lint);
        Some(lints)
    }
}

fn check_field(path: &str, v: Option<&Value>, rule: &FieldRule, lint: &mut impl FnMut(String, String)) {
    let Some(v) = v.filter(|v| !v.is_null()) else {
        if rule.required {
            lint(path.into(), "is required".into());
        }
        return;
    };
    let fail = |lint: &mut dyn FnMut(String, String), what: &str| lint(path.into(), format!("must be {what}"));
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
        FieldType::Blob => v.as_str().is_some_and(crate::note::valid_key),
    };
    if !ok {
        fail(lint, type_name(rule.ty));
        return;
    }
    let measure = match v {
        Value::Number(n) => n.as_f64(),
        Value::Sequence(s) => Some(s.len() as f64),
        _ => None,
    };
    if let Some(m) = measure {
        if rule.min.is_some_and(|min| m < min) {
            lint(path.into(), format!("must be at least {}", rule.min.unwrap()));
        }
        if rule.max.is_some_and(|max| m > max) {
            lint(path.into(), format!("must be at most {}", rule.max.unwrap()));
        }
    }
    if let Some(options) = &rule.one_of
        && !options.contains(v)
    {
        let shown: Vec<String> = options.iter().map(|o| crate::note::to_yaml(o).trim().to_owned()).collect();
        lint(path.into(), format!("must be one of {}", shown.join(", ")));
    }
    if let Value::Mapping(m) = v {
        for (sub, sub_rule) in &rule.fields {
            check_field(&format!("{path}.{sub}"), m.get(sub.as_str()), sub_rule, lint);
        }
    }
    if let (Value::Mapping(m), Some(value_rule)) = (v, &rule.values) {
        for (k, item) in m {
            check_field(&format!("{path}.{}", k.as_str().unwrap_or("?")), Some(item), value_rule, lint);
        }
    }
    if let (Value::Sequence(items), Some(item_rule)) = (v, &rule.items) {
        for (i, item) in items.iter().enumerate() {
            check_field(&format!("{path}.{i}"), Some(item), item_rule, lint);
        }
    }
}

/// `items` belongs to lists and `fields` to maps; anything else is a mistake in the definition.
fn check_rule(path: &str, rule: &FieldRule) -> Result<(), String> {
    if rule.items.is_some() && rule.ty != FieldType::List {
        return Err(format!("{path}: `items` needs `type: list`"));
    }
    if !rule.fields.is_empty() && rule.ty != FieldType::Map {
        return Err(format!("{path}: `fields` needs `type: map`"));
    }
    if rule.values.is_some() && rule.ty != FieldType::Map {
        return Err(format!("{path}: `values` needs `type: map`"));
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

fn check_counts(kind: &str, refs: &[Ref], rules: &BTreeMap<String, Count>, lint: &mut impl FnMut(String, String)) {
    for (label, count) in rules {
        let n = refs.iter().filter(|r| r.label.as_deref().unwrap_or("_") == label).count();
        if count.min.is_some_and(|min| n < min) {
            lint(format!("{kind}.{label}"), format!("needs at least {} `{label}`", count.min.unwrap()));
        }
        if count.max.is_some_and(|max| n > max) {
            lint(format!("{kind}.{label}"), format!("allows at most {} `{label}`", count.max.unwrap()));
        }
    }
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

pub(crate) fn is_partial_date_range(s: &str) -> bool {
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
}

/// The definitions shipped in `gestalts/`, embedded at build time.
const BUILTIN: &[&str] = &[
    include_str!("../../../gestalts/flashcard/v1.yml"),
    include_str!("../../../gestalts/appointment/v1.yml"),
    include_str!("../../../gestalts/link/v1.yml"),
    include_str!("../../../gestalts/fsrs-state/v1.yml"),
    include_str!("../../../gestalts/recurring/v1.yml"),
    include_str!("../../../gestalts/daily/v1.yml"),
    include_str!("../../../gestalts/project/v1.yml"),
    include_str!("../../../gestalts/issue/v1.yml"),
    include_str!("../../../gestalts/published/v1.yml"),
    include_str!("../../../gestalts/template/v1.yml"),
    include_str!("../../../gestalts/source/v1.yml"),
    include_str!("../../../gestalts/canvas/v1.yml"),
    include_str!("../../../gestalts/term/v1.yml"),
    include_str!("../../../gestalts/sentence/v1.yml"),
    include_str!("../../../gestalts/country/v1.yml"),
    include_str!("../../../gestalts/scene-object/v1.yml"),
    include_str!("../../../gestalts/interaction/v1.yml"),
    include_str!("../../../gestalts/practice-state/v1.yml"),
    include_str!("../../../gestalts/practice-session/v1.yml"),
    include_str!("../../../gestalts/settings/v1.yml"),
    include_str!("../../../gestalts/canvas/v2.yml"),
    include_str!("../../../gestalts/template/v2.yml"),
    include_str!("../../../gestalts/cards/v1.yml"),
    include_str!("../../../gestalts/conflict/v1.yml"),
    include_str!("../../../gestalts/pane/v1.yml"),
    include_str!("../../../gestalts/plugin-install/v1.yml"),
];

/// What identifies a card within its note, as dsl computes it: sha1 of the front with trailing whitespace on each
/// line and blank ends removed, its first 12 hex digits.
pub fn card_id(front: &str) -> String {
    let normalized = front.split('\n').map(str::trim_end).collect::<Vec<_>>().join("\n");
    let hex = sha1_smol::Sha1::from(normalized.trim()).digest().to_string();
    hex[..12].to_owned()
}

impl Gestalts {
    pub fn builtin() -> Self {
        Self::from_yaml(BUILTIN).expect("builtin gestalts are valid")
    }

    /// The core's gestalts plus `extra` (a plugin's, loaded at runtime). Fails on a broken definition, or one that
    /// redefines a gestalt.
    pub fn builtin_with(extra: &[&str]) -> Result<Self, String> {
        let mut all: Vec<&str> = BUILTIN.to_vec();
        all.extend_from_slice(extra);
        let g = Self::from_yaml(&all)?;
        let mut seen = std::collections::BTreeSet::new();
        for d in g.defs() {
            if !seen.insert(d.id()) {
                return Err(format!("{} is defined twice", d.id()));
            }
        }
        Ok(g)
    }

    pub fn from_yaml(sources: &[&str]) -> Result<Self, String> {
        let defs = sources
            .iter()
            .map(|s| serde_yaml_ng::from_str::<GestaltDef>(s).map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        for d in &defs {
            for (field, rule) in &d.fields {
                check_rule(field, rule).map_err(|e| format!("{}: {e}", d.id()))?;
            }
            if let Some(m) = &d.merge {
                gestalts_merge::Policy::parse(m).map_err(|e| format!("{}: merge: {e}", d.id()))?;
            }
        }
        Ok(Gestalts { defs })
    }

    pub fn defs(&self) -> &[GestaltDef] {
        &self.defs
    }

    /// by `name@version`
    pub fn get(&self, id: &str) -> Option<&GestaltDef> {
        self.defs.iter().find(|d| d.id() == id)
    }

    /// The gestalts the note has.
    pub fn of(&self, note: &Note) -> Vec<String> {
        self.defs.iter().filter(|d| d.check(note).is_some_and(|l| l.is_empty())).map(GestaltDef::id).collect()
    }

    /// Broken rules of every gestalt the note is a candidate for.
    pub fn lint(&self, note: &Note) -> Vec<Lint> {
        self.defs.iter().filter_map(|d| d.check(note)).flatten().collect()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn note(raw: &str) -> Note {
        Note::parse("k", raw)
    }

    /// The core's gestalts and those of the plugins these tests read about.
    pub(crate) fn with_plugins() -> Gestalts {
        Gestalts::builtin_with(&[
            include_str!("../../../plugins/greek-alphabet/gestalts/pronunciation-card/v1.yml"),
            include_str!("../../../plugins/typst/gestalts/typst-document/v1.yml"),
            include_str!("../../../plugins/quotes/gestalts/quote/v1.yml"),
        ])
        .unwrap()
    }

    #[test]
    fn builtins_load() {
        let g = Gestalts::builtin();
        assert!(g.get("flashcard@1").is_some());
        assert!(g.get("fsrs-state@1").is_some());
        assert!(g.get("flashcard@2").is_none());
    }

    #[test]
    fn a_note_can_have_several_gestalts() {
        let g = Gestalts::builtin();
        let n = note("tags: [appointment]\ndate: 2026-11-03\nurl: https://example.com/meet\n");
        assert_eq!(g.of(&n), vec!["appointment@1", "link@1"]);
        assert!(g.lint(&n).is_empty());
    }

    #[test]
    fn candidates_get_lints() {
        let g = Gestalts::builtin();
        let n = note("tags: [flashcard]\nfront: hola\n");
        assert!(g.of(&n).is_empty());
        let lints = g.lint(&n);
        assert_eq!(lints.len(), 1);
        assert_eq!(lints[0].path, "back");
        // not tagged: no lints, no gestalt
        assert!(g.lint(&note("front: hola")).is_empty());
        assert!(g.lint(&note("url: not a url")).iter().any(|l| l.gestalt == "link@1"));
        assert!(g.lint(&note("tags: [appointment]\ndate: 2026-13-01")).iter().any(|l| l.path == "date"));
    }

    #[test]
    fn pronunciation_card_and_fsrs_state() {
        let g = with_plugins();
        let card = note("title: δελφίς\nlang: grc\ntags: [pronunciation-card]\nblobs:\n  - {label: image, file: a.webp}\n  - {label: audio, file: a.mp3}\n");
        assert_eq!(g.of(&card), vec!["pronunciation-card@1"]);
        let no_audio = note("title: x\ntags: [pronunciation-card]\n");
        assert_eq!(g.lint(&no_audio)[0].path, "blobs.audio");

        let state = note(
            "tags: [fsrs-state]\nrelationships: [{to: abc, label: reviews}]\nmodel: FSRS-7\nlast_rating: 3\ncard:\n  dueAt: 2026-01-05T18:39:55.164Z\n  lastReviewAt: null\n  stability: 3.92\n  stabilityFast: 3.13\n  difficulty: 3.53\n  state: 2\n  scheduleStatus: review\n  reps: 1\n  lapses: 0\n  scheduledDays: 4.77\n  learningStep: 0\n",
        );
        assert_eq!(g.of(&state), vec!["fsrs-state@1"], "{:?}", g.lint(&state));
        let bad = note("tags: [fsrs-state]\nmodel: FSRS-7\nlast_rating: 7\ncard: {dueAt: tomorrow}\n");
        let paths: Vec<_> = g.lint(&bad).into_iter().map(|l| l.path).collect();
        assert!(paths.contains(&"last_rating".to_string()));
        assert!(paths.contains(&"card.dueAt".to_string()));
        assert!(paths.contains(&"relationships.reviews".to_string()));
    }

    #[test]
    fn partial_dates() {
        for ok in ["2026", "2026-05", "2026-05-17", "2020/2021", "2020-05/", "/2021"] {
            assert!(is_partial_date_range(ok), "{ok}");
        }
        for bad in ["26", "2026-13", "2026-5", "/", "2026-05-32", "may 2026"] {
            assert!(!is_partial_date_range(bad), "{bad}");
        }
        let g = Gestalts::builtin();
        assert_eq!(g.of(&note("tags: [appointment]\ndate: 2026-11\n")), vec!["appointment@1"]);
    }

    #[test]
    fn list_items_are_checked() {
        let g = Gestalts::builtin();
        let ok = note("tags: [canvas]\nrelationships: [{to: h, label: canvas-of}]\nnodes:\n  - {id: a, x: 0, y: 1.5, text: hi}\n  - {id: b, x: 3, y: 4, note: n}\n");
        assert_eq!(g.of(&ok), vec!["canvas@1"], "{:?}", g.lint(&ok));
        let bad = note("tags: [canvas]\nrelationships: [{to: h, label: canvas-of}]\nnodes:\n  - {id: a, x: left, y: 0}\n  - 7\n");
        let paths: Vec<_> = g.lint(&bad).into_iter().map(|l| l.path).collect();
        assert_eq!(paths, vec!["nodes.0.x", "nodes.1"]);
    }

    #[test]
    fn misplaced_items_or_fields_are_rejected() {
        assert!(Gestalts::from_yaml(&["name: x\nversion: 1\nfields:\n  a: { type: map, items: { type: string } }\n"]).is_err());
        assert!(Gestalts::from_yaml(&["name: x\nversion: 1\nfields:\n  a: { type: list, fields: { b: { type: string } } }\n"]).is_err());
        assert!(Gestalts::builtin_with(&["name: flashcard\nversion: 1\n"]).is_err(), "redefined");
    }

    #[test]
    fn source_and_typst_document() {
        let g = with_plugins();
        let s = note("tags: [source]\ntitle: Attention Is All You Need\ncitekey: vaswani2017\nentrytype: inproceedings\nauthor: [\"Vaswani, Ashish\", World Health Organization]\ndate: 2017-06\nvolume: \"30\"\nurl: https://arxiv.org/abs/1706.03762\nbib_extra: {keywords: transformers}\n");
        assert_eq!(g.of(&s), vec!["link@1", "source@1"], "{:?}", g.lint(&s));
        let t = note("tags: [typst]\nsource: \"= Hi\"\nassets: {/images/a.webp: 0123456789abcdef.webp}\nrelationships: [{to: h, label: document-of}]\n");
        assert_eq!(g.of(&t), vec!["typst-document@1"], "{:?}", g.lint(&t));
    }

    #[test]
    fn every_definition_file_is_builtin() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../gestalts");
        let g = Gestalts::builtin();
        for entry in std::fs::read_dir(&dir).unwrap() {
            let entry = entry.unwrap();
            for file in std::fs::read_dir(entry.path()).unwrap() {
                let file = file.unwrap().file_name().into_string().unwrap();
                let version = file.strip_prefix('v').and_then(|f| f.strip_suffix(".yml")).expect("gestalts/<name>/v<N>.yml");
                let id = format!("{}@{version}", entry.file_name().to_string_lossy());
                assert!(g.get(&id).is_some(), "{id} is missing from BUILTIN");
            }
        }
    }

    #[test]
    fn folded_forms() {
        let g = Gestalts::builtin();
        has(&g, "title: host\ncanvas:\n  nodes:\n    - {id: a, x: 0, y: 1.5, text: hi}\n    - {id: b, x: 3, y: 4, note: n}\nrelationships: [{to: n, label: on-canvas}]\n", "canvas@2");
        assert_eq!(lint_paths(&g, "canvas: {nodes: [{id: a, x: left, y: 0}]}\n"), vec!["canvas.nodes.0.x"]);
        assert_eq!(lint_paths(&g, "canvas: {}\n"), vec!["canvas.nodes"]);
        has(&g, "template: {format: jinja-html, source: \"<h1>{{ title }}</h1>\", name: _index.html.j2}\n", "template@2");
        assert_eq!(lint_paths(&g, "template: {format: mustache}\n"), vec!["template.format", "template.source"]);
        has(&g, "main: x\ncards:\n  - {id: d15af94d944d, front: Was ist das?, back: what is that}\n", "cards@1");
        assert_eq!(lint_paths(&g, "cards: [{front: x}]\n"), vec!["cards.0.back", "cards.0.id"]);
        // the old forms keep their gestalts
        has(&g, "tags: [canvas]\nrelationships: [{to: h, label: canvas-of}]\nnodes: []\n", "canvas@1");
    }

    #[test]
    fn card_ids_are_dsls() {
        // values from dsl_crud.core.flashcards.card_id
        assert_eq!(card_id("Was ist das?"), "d15af94d944d");
        assert_eq!(card_id("  hola  \n\nmundo \n"), "594284149d1e");
    }

    #[track_caller]
    fn has(g: &Gestalts, raw: &str, id: &str) {
        let n = note(raw);
        assert!(g.of(&n).contains(&id.to_string()), "{id}: {:?}", g.lint(&n));
    }

    #[track_caller]
    fn lint_paths(g: &Gestalts, raw: &str) -> Vec<String> {
        g.lint(&note(raw)).into_iter().map(|l| l.path).collect()
    }

    #[test]
    fn integration_gestalts() {
        let g = with_plugins();
        has(&g, "tags: [term]\ntitle: كتاب\nlang: ar\ntranslations: [book]\ntransliteration: kitāb\nexamples:\n  - {text: هذا كتاب, translation: this is a book}\naliases: [كتب]\nblobs: [{label: audio, file: a.mp3}]\n", "term@1");
        has(&g, "tags: [term]\ntitle: ٣\nvalue: 3\n", "term@1");
        assert_eq!(lint_paths(&g, "tags: [term]\ntitle: x\nexamples: [{translation: y}]\nblobs: [{label: image, file: a}, {label: image, file: b}]\n"), vec!["examples.0.text", "blobs.image"]);

        has(&g, "tags: [sentence]\ntitle: Ich sehe den Hund.\nlang: de\ntranslations: [I see the dog.]\nparts:\n  - {content: Ich, translations: [I], term: t1}\n  - {content: sehe}\ngaps: [{word: den, at: 2, distractors: [der]}]\ncredits: [{for: audio, text: Tatoeba}]\nstart: 3.5\nend: 5\nrelationships: [{to: v, label: segment-of}]\n", "sentence@1");
        assert_eq!(lint_paths(&g, "tags: [sentence]\ntitle: x\ngaps: [{at: -1}]\nstart: -2\n"), vec!["gaps.0.at", "gaps.0.word", "start"]);

        has(&g, "tags: [quote]\nmain: Brevity is the soul of wit.\nattribution: Shakespeare\nrelationships: [{to: s, label: cites}]\n", "quote@1");
        assert_eq!(lint_paths(&g, "tags: [quote]\nattribution: x\n"), vec!["main"]);

        has(&g, "tags: [country]\ntitle: Germany\ncode: DEU\nalpha2: DE\npriority: 1\nworld_map: {zoom: 4}\nblobs: [{label: flag, file: f.svg}]\nrelationships: [{to: aut, label: distractor}]\n", "country@1");
        assert_eq!(lint_paths(&g, "tags: [country]\ntitle: Germany\n"), vec!["code"]);

        has(&g, "tags: [scene-object]\ntitle: cup\nprops: {color: red}\nblobs: [{label: model, file: cup.glb}]\n", "scene-object@1");
        has(&g, "tags: [interaction]\naction: give\neffects: {receiver: happy}\ninstructions: {de: [Gib ihm die Tasse.]}\nrelationships: [{to: a, label: actor}, {to: b, label: target}]\n", "interaction@1");
        assert_eq!(lint_paths(&g, "tags: [interaction]\naction: give\nrelationships: [{to: b, label: target}, {to: c, label: target}]\n"), vec!["relationships.actor", "relationships.target"]);

        has(&g, "tags: [practice-state]\nmodel: ebisu\nfacet: de\nstate: {alpha: 3, beta: 3, t: 24}\nrelationships: [{to: c, label: reviews}]\n", "practice-state@1");
        assert_eq!(lint_paths(&g, "tags: [practice-state]\nmodel: streak\n"), vec!["state", "relationships.reviews"]);

        has(&g, "tags: [practice-session]\napp: hebrew-script\nstarted: 2026-11-03T10:00:00Z\nended: 2026-11-03T10:12:00Z\nactive_ms: 540000\ntrials: 42\nevents:\n  - {at: 2026-11-03T10:00:05Z, card: c, correct: true}\n", "practice-session@1");
        assert_eq!(lint_paths(&g, "tags: [practice-session]\napp: x\nstarted: 2026-11-03T10:00:00Z\nevents: [{card: c}]\ntrials: -1\n"), vec!["events.0.at", "trials"]);

        has(&g, "tags: [settings]\nscope: daily\nsentence_goal: 10\n", "settings@1");
        assert_eq!(lint_paths(&g, "tags: [settings]\n"), vec!["scope"]);

        let faceted = "tags: [fsrs-state]\nfacet: cloze:2\nrelationships: [{to: q, label: reviews}]\nmodel: FSRS-7\nlast_rating: 3\ncard: {dueAt: 2026-01-05T18:39:55.164Z, stability: 1, difficulty: 5, state: 1, reps: 1, lapses: 0}\n";
        has(&g, faceted, "fsrs-state@1");
    }
}
