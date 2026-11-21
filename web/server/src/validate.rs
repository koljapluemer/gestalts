//! What a draft's folder may hold, checked on every write: the browser is untrusted here.
//!
//! - every yml is valid by the core's gestalts, the model packages', or the draft's own definitions, or a tombstone
//! - its own definitions (`gestalt@1`) are named in its package, never another's
//! - the view yml (`view@1`/`view@2`) has the draft's id and package, and nothing else has that id
//! - within the limits on how many ymls and how big

use std::collections::{BTreeMap, BTreeSet};

use gestalts_core::gestalt::{DEFINITION_PREFIX, GESTALT};
use gestalts_core::{Gestalts, Yml, YmlState};

use crate::Limits;

/// The gestalts of a draft's views.
pub fn is_view(gestalt: &str) -> bool {
    matches!(gestalt, "view@1" | "view@2")
}

/// A draft's ymls as they would be after a write.
pub struct Batch<'a> {
    pub draft: &'a str,
    pub package: &'a str,
    /// what's being written
    pub incoming: &'a BTreeMap<String, String>,
    /// the ids already there
    pub existing: &'a BTreeSet<String>,
    /// the definitions already there, by id, unless overwritten
    pub definitions: &'a BTreeMap<String, String>,
}

/// The definitions `gestalts` gets from a draft's definition ymls: those valid and in its package.
pub fn draft_gestalts(base: &Gestalts, package: &str, texts: impl IntoIterator<Item = (String, String)>) -> Gestalts {
    let prefix = format!("{package}/");
    let defs = texts.into_iter().filter_map(|(id, text)| {
        let y = Yml::parse(id, text);
        matches!(base.classify(&y), YmlState::Valid(_)).then(|| base.definition(&y).ok()).flatten().filter(|d| d.name.starts_with(&prefix))
    });
    base.with_data(defs)
}

/// What's wrong with a write, each as `<id>: why`; empty when it may go ahead.
pub fn check(base: &Gestalts, limits: &Limits, b: &Batch<'_>) -> Vec<String> {
    let mut problems = Vec::new();
    let mut texts: BTreeMap<String, String> = b.definitions.clone();
    texts.extend(b.incoming.iter().filter(|(id, _)| id.starts_with(DEFINITION_PREFIX)).map(|(id, t)| (id.clone(), t.clone())));
    let gestalts = draft_gestalts(base, b.package, texts);
    let prefix = format!("{}/", b.package);
    for (id, text) in b.incoming {
        if !gestalts_core::yml::valid_key(id) {
            problems.push(format!("{id}: not an id"));
            continue;
        }
        if text.len() > limits.yml_bytes {
            problems.push(format!("{id}: longer than {} bytes", limits.yml_bytes));
            continue;
        }
        let y = Yml::parse(id.clone(), text.clone());
        match gestalts.classify(&y) {
            YmlState::Valid(g) => {
                if g == GESTALT {
                    let name = gestalts.definition(&y).map(|d| d.name).unwrap_or_default();
                    if !name.starts_with(&prefix) {
                        problems.push(format!("{id}: defines {name}, but this draft's gestalts are named {prefix}<name>"));
                    }
                } else if is_view(&g) {
                    if id != b.draft {
                        problems.push(format!("{id}: a draft has one view, {}", b.draft));
                    } else if g == "view@2" && y.str_field("package") != Some(b.package) {
                        problems.push(format!("{id}: its package is {}", b.package));
                    }
                } else if id == b.draft {
                    problems.push(format!("{id}: the draft's own id is its view's"));
                }
            }
            YmlState::Tombstone if id == b.draft => problems.push(format!("{id}: the view can't be deleted, only the draft")),
            YmlState::Tombstone => {}
            YmlState::Unknown(g) => problems.push(format!("{id}: no gestalt {g} here")),
            YmlState::Invalid(p) => problems.push(format!("{id}: {}", p.iter().map(|p| if p.path.is_empty() { p.message.clone() } else { format!("{} {}", p.path, p.message) }).collect::<Vec<_>>().join("; "))),
        }
    }
    let total = b.existing.iter().chain(b.incoming.keys()).collect::<BTreeSet<_>>().len();
    if total > limits.ymls_per_draft {
        problems.push(format!("a draft holds at most {} ymls", limits.ymls_per_draft));
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(incoming: &[(&str, &str)], definitions: &[(&str, &str)]) -> Vec<String> {
        let base = Gestalts::builtin();
        let incoming: BTreeMap<String, String> = incoming.iter().map(|(a, b)| ((*a).to_owned(), (*b).to_owned())).collect();
        let definitions: BTreeMap<String, String> = definitions.iter().map(|(a, b)| ((*a).to_owned(), (*b).to_owned())).collect();
        let existing = definitions.keys().cloned().collect();
        check(&base, &Limits { ymls_per_draft: 4, ..Limits::default() }, &Batch { draft: "v", package: "d-abc", incoming: &incoming, existing: &existing, definitions: &definitions })
    }

    const VIEW: &str = "id: v\ngestalt: view@2\ntitle: T\nsource: x\nreads: []\nwrites: []\npackage: d-abc\n";
    const NOUN: &str = "id: gestalt-d-abc.noun.1\ngestalt: gestalt@1\nname: d-abc/noun\nversion: 1\nfields:\n  word: { type: string, required: true }\n";

    #[test]
    fn a_draft_with_its_own_gestalt_and_content() {
        assert_eq!(run(&[("v", VIEW), ("gestalt-d-abc.noun.1", NOUN), ("haus", "id: haus\ngestalt: d-abc/noun@1\nword: Haus\n")], &[]), Vec::<String>::new());
        // the definition already there
        assert_eq!(run(&[("baum", "id: baum\ngestalt: d-abc/noun@1\nword: Baum\n")], &[("gestalt-d-abc.noun.1", NOUN)]), Vec::<String>::new());
        assert_eq!(run(&[("n", "id: n\ndeleted: 2026-11-20T10:00:00Z\n")], &[]), Vec::<String>::new());
    }

    #[test]
    fn what_a_draft_may_not_hold() {
        for (why, incoming, defs) in [
            ("invalid by its definition", vec![("haus", "id: haus\ngestalt: d-abc/noun@1\n")], vec![("gestalt-d-abc.noun.1", NOUN)]),
            ("another draft's gestalt", vec![("x", "id: x\ngestalt: d-other/noun@1\nword: x\n")], vec![]),
            ("a definition in another package", vec![("gestalt-d-other.noun.1", "id: gestalt-d-other.noun.1\ngestalt: gestalt@1\nname: d-other/noun\nversion: 1\n")], vec![]),
            ("a second view", vec![("w", &VIEW.replace("id: v", "id: w"))], vec![]),
            ("the view in another package", vec![("v", &VIEW.replace("package: d-abc", "package: d-x"))], vec![]),
            ("the view's id for something else", vec![("v", "id: v\ngestalt: note@1\n")], vec![]),
            ("the view deleted", vec![("v", "id: v\ndeleted: 2026-11-20T10:00:00Z\n")], vec![]),
            ("not parsing", vec![("x", "a: [")], vec![]),
        ] {
            let incoming: Vec<(&str, &str)> = incoming.iter().map(|(a, b)| (*a, *b)).collect();
            assert!(!run(&incoming, &defs).is_empty(), "{why}");
        }
        let notes: Vec<(String, String)> = ["a", "b", "c", "d", "e"].iter().map(|i| ((*i).to_owned(), format!("id: {i}\ngestalt: note@1\n"))).collect();
        let notes: Vec<(&str, &str)> = notes.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        assert_eq!(run(&notes[..4], &[]), Vec::<String>::new());
        assert_eq!(run(&notes, &[]).len(), 1, "too many");
    }
}
