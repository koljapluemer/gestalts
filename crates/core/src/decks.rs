//! Decks: read-only ymls shipped with a plugin, mounted under the user's own storage ([`crate::storage::Layered`]).
//!
//! Decks that hold the same id hold the same thing, so their texts are merged by the gestalt's merge rules, without a
//! base: a concept shared by two decks has the `aliases` of both. Decks are read-only, so a value they disagree on
//! keeps the merge's canonical winner and is reported, never written.

use std::collections::BTreeMap;

use crate::gestalt::Gestalts;
use crate::merge::merge_yml;
use crate::storage::{Result, Storage};

/// A mounted deck: its `source` id (`<plugin>/<deck>`) and its ymls.
#[derive(Clone, Copy)]
pub struct DeckRef<'a> {
    pub source: &'a str,
    pub storage: &'a dyn Storage,
}

/// The mounted decks, read as one.
pub struct Decks<'a> {
    pub decks: Vec<DeckRef<'a>>,
    pub gestalts: &'a Gestalts,
}

/// One id as the decks have it.
#[derive(Debug, PartialEq)]
pub struct Merged {
    pub text: String,
    /// what they disagree on, as paths
    pub conflicts: Vec<String>,
}

impl Decks<'_> {
    /// The decks' texts of `id`, merged in the order of their sources (so the result doesn't depend on mount order).
    pub async fn read(&self, id: &str) -> Result<Option<Merged>> {
        let mut texts = Vec::new();
        for d in &self.decks {
            if let Some(t) = d.storage.read_yml(id).await? {
                texts.push((d.source.to_owned(), t));
            }
        }
        Ok(merge_texts(id, texts, self.gestalts))
    }

    /// Every id of every deck, merged where several hold it.
    pub async fn read_all(&self) -> Result<BTreeMap<String, Merged>> {
        let mut by_id: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
        for d in &self.decks {
            for (id, t) in d.storage.read_all_ymls().await? {
                by_id.entry(id).or_default().push((d.source.to_owned(), t));
            }
        }
        Ok(by_id.into_iter().filter_map(|(id, texts)| merge_texts(&id, texts, self.gestalts).map(|m| (id, m))).collect())
    }
}

fn merge_texts(id: &str, mut texts: Vec<(String, String)>, gestalts: &Gestalts) -> Option<Merged> {
    texts.sort();
    let mut it = texts.into_iter();
    let (_, mut text) = it.next()?;
    let mut conflicts = Vec::new();
    for (_, t) in it {
        let m = merge_yml(id, None, Some(&text), Some(&t), gestalts, "");
        conflicts.extend(m.conflicts.iter().map(|c| format!("{id}: {}", path_text(&c.path))));
        text = m.text.unwrap_or(text);
    }
    Some(Merged { text, conflicts })
}

fn path_text(path: &[gestalts_merge::Segment]) -> String {
    let parts: Vec<String> = path
        .iter()
        .map(|s| match s {
            gestalts_merge::Segment::Key(k) => k.clone(),
            gestalts_merge::Segment::Item { by, id } => format!("[{by}={}]", gestalts_merge::canonical(id)),
        })
        .collect();
    if parts.is_empty() { "(whole yml)".into() } else { parts.join(".") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Memory;
    use crate::yml::parse_yaml;

    #[test]
    fn two_decks_add_up_on_a_shared_concept() {
        pollster::block_on(async {
            let g = Gestalts::builtin();
            let (a, b) = (Memory::default(), Memory::default());
            a.write_yml("c", "id: c\ngestalt: concept@2\nname: x\naliases: [p1]\n").await.unwrap();
            b.write_yml("c", "id: c\ngestalt: concept@2\nname: x\naliases: [p2]\n").await.unwrap();
            let decks = Decks { decks: vec![DeckRef { source: "p/a", storage: &a }, DeckRef { source: "p/b", storage: &b }], gestalts: &g };
            let m = decks.read("c").await.unwrap().unwrap();
            assert!(m.conflicts.is_empty(), "{:?}", m.conflicts);
            let merged = parse_yaml(&m.text).unwrap();
            let parents = merged["aliases"].as_sequence().unwrap();
            assert_eq!(parents.len(), 2);
            for p in ["p1", "p2"] {
                assert!(parents.iter().any(|x| x.as_str() == Some(p)), "{parents:?}");
            }
        });
    }
}
