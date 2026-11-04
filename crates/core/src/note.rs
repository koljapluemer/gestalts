//! A note: one YAML file. Any YAML is accepted; the conventional fields get helpers.

use serde::Serialize;
use serde_yaml_ng::{Mapping, Value};

/// Where and why a note's text failed to parse.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ParseError {
    pub message: String,
    /// 1-based, when known
    pub line: Option<usize>,
    pub column: Option<usize>,
}

/// A labelled (or unlabelled) reference, used for both `relationships` and `blobs`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Ref {
    pub target: String,
    pub label: Option<String>,
}

/// A note as stored. `raw` is the source of truth; `value` is its parse, when it parses.
#[derive(Debug, Clone, Serialize)]
pub struct Note {
    /// the file name without `.yml`; usually equal to `id`
    pub key: String,
    pub raw: String,
    pub value: Option<Value>,
    pub parse_error: Option<ParseError>,
}

impl Note {
    pub fn parse(key: impl Into<String>, raw: impl Into<String>) -> Self {
        let raw = raw.into();
        let (value, parse_error) = match parse_yaml(&raw) {
            Ok(v) => (Some(v), None),
            Err(e) => (None, Some(e)),
        };
        Note { key: key.into(), raw, value, parse_error }
    }

    fn map(&self) -> Option<&Mapping> {
        self.value.as_ref()?.as_mapping()
    }

    pub fn get(&self, field: &str) -> Option<&Value> {
        self.map()?.get(field)
    }

    pub fn str_field(&self, field: &str) -> Option<&str> {
        self.get(field)?.as_str()
    }

    /// The `id` field, else the key: notes without an id are still addressable.
    pub fn id(&self) -> &str {
        self.str_field("id").unwrap_or(&self.key)
    }

    pub fn title(&self) -> Option<&str> {
        self.str_field("title")
    }

    pub fn main(&self) -> Option<&str> {
        self.str_field("main")
    }

    pub fn tags(&self) -> Vec<&str> {
        string_list(self.get("tags"))
    }

    pub fn aliases(&self) -> Vec<&str> {
        string_list(self.get("aliases"))
    }

    pub fn has_tag(&self, tag: &str) -> bool {
        self.tags().contains(&tag)
    }

    pub fn relationships(&self) -> Vec<Ref> {
        refs(self.get("relationships"), "to")
    }

    pub fn blobs(&self) -> Vec<Ref> {
        refs(self.get("blobs"), "file")
    }
}

/// Parses YAML; an empty document is an empty map, not null.
pub fn parse_yaml(raw: &str) -> Result<Value, ParseError> {
    if raw.trim().is_empty() {
        return Ok(Value::Mapping(Mapping::new()));
    }
    serde_yaml_ng::from_str::<Value>(raw).map_err(|e| {
        let loc = e.location();
        ParseError {
            message: e.to_string(),
            line: loc.as_ref().map(|l| l.line()),
            column: loc.as_ref().map(|l| l.column()),
        }
    })
}

pub fn to_yaml(value: &Value) -> String {
    serde_yaml_ng::to_string(value).unwrap_or_default()
}

fn string_list(v: Option<&Value>) -> Vec<&str> {
    match v {
        Some(Value::Sequence(items)) => items.iter().filter_map(Value::as_str).collect(),
        Some(Value::String(s)) => vec![s.as_str()],
        _ => vec![],
    }
}

/// Items are either `"<target>"` or `{<target_key>: <target>, label: <label>}`.
fn refs(v: Option<&Value>, target_key: &str) -> Vec<Ref> {
    let Some(Value::Sequence(items)) = v else { return vec![] };
    items
        .iter()
        .filter_map(|item| match item {
            Value::String(s) => Some(Ref { target: s.clone(), label: None }),
            Value::Mapping(m) => Some(Ref {
                target: m.get(target_key)?.as_str()?.to_owned(),
                label: m.get("label").and_then(Value::as_str).map(str::to_owned),
            }),
            _ => None,
        })
        .collect()
}

/// Keys become file names, so they must not escape the folder.
pub fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 200
        && !key.starts_with('.')
        && !key.chars().any(|c| matches!(c, '/' | '\\' | '\0') || c.is_control())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conventional_fields() {
        let n = Note::parse(
            "k",
            "id: abc\ntitle: Hi\ntags: [a, b]\nrelationships:\n  - x\n  - {to: y, label: opposite}\nblobs:\n  - {file: f.webp, label: image}\n",
        );
        assert_eq!(n.id(), "abc");
        assert_eq!(n.title(), Some("Hi"));
        assert_eq!(n.tags(), vec!["a", "b"]);
        assert_eq!(n.relationships()[1], Ref { target: "y".into(), label: Some("opposite".into()) });
        assert_eq!(n.relationships()[0].label, None);
        assert_eq!(n.blobs()[0].target, "f.webp");
    }

    #[test]
    fn robust_without_id_or_valid_yaml() {
        let n = Note::parse("my-note", "title: x");
        assert_eq!(n.id(), "my-note");
        let bad = Note::parse("bad", "a: [unclosed");
        assert!(bad.value.is_none());
        assert!(bad.parse_error.as_ref().unwrap().line.is_some());
        assert_eq!(bad.id(), "bad");
        assert!(bad.tags().is_empty());
        // a scalar document is valid YAML, just not a map
        assert!(Note::parse("s", "just text").title().is_none());
        assert!(Note::parse("e", "").value.unwrap().is_mapping());
    }

    #[test]
    fn keys() {
        assert!(valid_key("3f2c-uuid"));
        assert!(valid_key("δελφίς"));
        assert!(!valid_key("../etc"));
        assert!(!valid_key("a/b"));
        assert!(!valid_key(".hidden"));
    }
}
