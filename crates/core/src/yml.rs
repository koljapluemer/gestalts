//! A yml: one file in `notes/`, named after its `id`. Its text is the source of truth; what it means is decided by
//! the one gestalt it names ([`crate::gestalt`]).

use serde::Serialize;
use serde_yaml_ng::{Mapping, Value};
use sha2::{Digest, Sha256};

/// Where and why a yml's text failed to parse.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ParseError {
    pub message: String,
    /// 1-based, when known
    pub line: Option<usize>,
    pub column: Option<usize>,
}

/// A yml as stored. `raw` is the source of truth; `value` is its parse, when it parses.
#[derive(Debug, Clone, Serialize)]
pub struct Yml {
    /// the file name without `.yml`
    pub id: String,
    pub raw: String,
    pub value: Option<Value>,
    pub parse_error: Option<ParseError>,
}

impl Yml {
    pub fn parse(id: impl Into<String>, raw: impl Into<String>) -> Self {
        let raw = raw.into();
        let (value, parse_error) = match parse_yaml(&raw) {
            Ok(v) => (Some(v), None),
            Err(e) => (None, Some(e)),
        };
        Yml { id: id.into(), raw, value, parse_error }
    }

    pub fn map(&self) -> Option<&Mapping> {
        self.value.as_ref()?.as_mapping()
    }

    pub fn get(&self, field: &str) -> Option<&Value> {
        self.map()?.get(field)
    }

    pub fn str_field(&self, field: &str) -> Option<&str> {
        self.get(field)?.as_str()
    }

    /// The gestalt this yml names, as written.
    pub fn gestalt(&self) -> Option<&str> {
        self.str_field("gestalt")
    }
}

/// Parses YAML; an empty document is an empty map, not null.
pub fn parse_yaml(raw: &str) -> Result<Value, ParseError> {
    if raw.trim().is_empty() {
        return Ok(Value::Mapping(Mapping::new()));
    }
    serde_yaml_ng::from_str::<Value>(raw).map_err(|e| {
        let loc = e.location();
        ParseError { message: e.to_string(), line: loc.as_ref().map(|l| l.line()), column: loc.as_ref().map(|l| l.column()) }
    })
}

pub fn to_yaml(value: &Value) -> String {
    serde_yaml_ng::to_string(value).unwrap_or_default()
}

/// Hex sha256, used for sync and content-addressed blob names.
pub fn content_hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Ids and blob names become file names, so they must not escape the folder.
pub fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 200 && !key.starts_with('.') && !key.chars().any(|c| matches!(c, '/' | '\\' | '\0') || c.is_control())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_or_says_why_not() {
        let y = Yml::parse("a", "id: a\ngestalt: note@1\n");
        assert_eq!(y.gestalt(), Some("note@1"));
        let bad = Yml::parse("bad", "a: [unclosed");
        assert!(bad.value.is_none());
        assert!(bad.parse_error.unwrap().line.is_some());
        assert!(Yml::parse("e", "").value.unwrap().is_mapping());
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
