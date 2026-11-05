//! Copy-on-write from read-only upstreams (shipped decks) into the user's own storage.
//!
//! - User space is closed under references: a note there whose `relationships` point at a note that
//!   only exists upstream gets that note copied in, with its blobs (and, in turn, its references).
//! - Decks that hold the same key hold the same thing (a country by its ISO code): their texts are merged by the
//!   gestalts' merge rules, without a base ([`Decks::read`]). Decks are read-only, so a value they disagree on keeps
//!   the merge's canonical winner and is reported, never written.
//! - Every copy is the merged upstream text plus a provenance trailer (`upstream: {sources, hash}`), so a copy the
//!   user never edited can be fast-forwarded when upstream changes, or when decks are mounted or unmounted.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::gestalt::Gestalts;
use crate::merge::merge_note;
use crate::note::Note;
use crate::storage::{Result, Storage};

/// Hex sha256, used for provenance and content-addressed blob names.
pub fn content_hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

const TRAILER_START: &str = "upstream:\n  sources: [";

/// The upstream text as copies start with it: ending in a newline, so the trailer can follow.
fn normalized(base: &str) -> String {
    let mut s = base.to_owned();
    if !s.is_empty() && !s.ends_with('\n') {
        s.push('\n');
    }
    s
}

/// `base` as copied into user space: the upstream text with the provenance trailer appended.
pub fn with_provenance(base: &str, sources: &[String]) -> String {
    let body = normalized(base);
    let hash = content_hash(body.as_bytes());
    format!("{body}{TRAILER_START}{}]\n  hash: {hash}\n", sources.join(", "))
}

/// Where a copy came from, read off its trailer.
#[derive(Debug, PartialEq)]
pub struct Provenance<'a> {
    /// the decks whose texts were merged into it
    pub sources: Vec<&'a str>,
    pub hash: &'a str,
    /// whether the text before the trailer is still exactly what was copied
    pub untouched: bool,
}

/// `None` if `text` doesn't end in a provenance trailer.
pub fn provenance(text: &str) -> Option<Provenance<'_>> {
    let at = text.rmatch_indices(TRAILER_START).map(|(i, _)| i).find(|&i| i == 0 || text[..i].ends_with('\n'))?;
    let (body, rest) = text.split_at(at);
    let (list, hash) = rest[TRAILER_START.len()..].strip_suffix('\n')?.split_once("]\n  hash: ")?;
    if hash.contains('\n') || list.is_empty() {
        return None;
    }
    let sources = list.split(", ").collect();
    Some(Provenance { sources, hash, untouched: content_hash(body.as_bytes()) == hash })
}

/// What [`pull_upstream`] did, by note key.
#[derive(Debug, Default, Serialize, PartialEq)]
pub struct UpstreamReport {
    /// copied into user space because something there referenced them
    pub copied: Vec<String>,
    /// untouched copies that were fast-forwarded to a changed upstream
    pub updated: Vec<String>,
    /// edited copies whose upstream changed; left as they are
    pub diverged: Vec<String>,
    /// notes that mounted decks disagree on (a value no merge rule settles), as `key: path`
    pub deck_conflicts: Vec<String>,
}

/// A read-only deck as copy-on-write sees it: its `source` id (`<plugin>/<deck>`) and its notes.
#[derive(Clone, Copy)]
pub struct DeckRef<'a> {
    pub source: &'a str,
    pub storage: &'a dyn Storage,
}

/// The mounted decks, read as one: a key several of them hold is the merge of their texts.
pub struct Decks<'a> {
    pub decks: Vec<DeckRef<'a>>,
    pub gestalts: &'a Gestalts,
}

/// One key as the decks have it.
#[derive(Debug, PartialEq)]
pub struct Merged {
    pub text: String,
    /// the decks that hold it, sorted
    pub sources: Vec<String>,
    /// what they disagree on, as paths
    pub conflicts: Vec<String>,
}

impl Decks<'_> {
    /// The decks' texts of `key`, merged in the order of their sources (so the result doesn't depend on mount order).
    pub async fn read(&self, key: &str) -> Result<Option<Merged>> {
        let mut texts = Vec::new();
        for d in &self.decks {
            if let Some(t) = d.storage.read_note(key).await? {
                texts.push((d.source.to_owned(), t));
            }
        }
        Ok(merge_texts(key, texts, self.gestalts))
    }

    /// Every key of every deck, merged where several hold it.
    pub async fn read_all(&self) -> Result<BTreeMap<String, Merged>> {
        let mut by_key: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
        for d in &self.decks {
            for (k, t) in d.storage.read_all_notes().await? {
                by_key.entry(k).or_default().push((d.source.to_owned(), t));
            }
        }
        Ok(by_key.into_iter().filter_map(|(k, texts)| merge_texts(&k, texts, self.gestalts).map(|m| (k, m))).collect())
    }

    /// The first deck among `sources` that has the blob `name`.
    async fn read_blob(&self, sources: &[String], name: &str) -> Result<Option<Vec<u8>>> {
        for d in self.decks.iter().filter(|d| sources.iter().any(|s| s == d.source)) {
            if let Some(b) = d.storage.read_blob(name).await? {
                return Ok(Some(b));
            }
        }
        Ok(None)
    }

    async fn copy_blobs(&self, top: &dyn Storage, m: &Merged, note: &Note) -> Result<()> {
        for b in note.blobs() {
            if top.read_blob(&b.target).await?.is_none()
                && let Some(bytes) = self.read_blob(&m.sources, &b.target).await?
            {
                top.write_blob(&b.target, &bytes).await?;
            }
        }
        Ok(())
    }
}

fn merge_texts(key: &str, mut texts: Vec<(String, String)>, gestalts: &Gestalts) -> Option<Merged> {
    texts.sort();
    let mut it = texts.into_iter();
    let (first, mut text) = it.next()?;
    let mut sources = vec![first];
    let mut conflicts = Vec::new();
    for (source, t) in it {
        let m = merge_note(key, None, Some(&text), Some(&t), gestalts, "");
        conflicts.extend(m.conflicts.iter().map(|c| format!("{key}: {}", path_text(&c.path))));
        text = m.text.unwrap_or(text);
        sources.push(source);
    }
    Some(Merged { text, sources, conflicts })
}

fn path_text(path: &[gestalts_merge::Segment]) -> String {
    let parts: Vec<String> = path
        .iter()
        .map(|s| match s {
            gestalts_merge::Segment::Key(k) => k.clone(),
            gestalts_merge::Segment::Item { by, id } => format!("[{by}={}]", gestalts_merge::canonical(id)),
        })
        .collect();
    if parts.is_empty() { "(whole note)".into() } else { parts.join(".") }
}

/// Copies `key` (and whatever it references) from the decks into `top`, unless `top` has it already (a tombstone
/// there counts: a deleted copy isn't copied back). Returns the keys copied.
pub async fn copy_up(decks: &Decks<'_>, top: &dyn Storage, key: &str) -> Result<Vec<String>> {
    let mut copied = Vec::new();
    let mut seen = BTreeSet::new();
    let mut todo = vec![key.to_owned()];
    while let Some(key) = todo.pop() {
        if !seen.insert(key.clone()) || top.read_note(&key).await?.is_some() {
            continue;
        }
        let Some(m) = decks.read(&key).await? else { continue };
        let note = Note::parse(key.clone(), m.text.clone());
        decks.copy_blobs(top, &m, &note).await?;
        top.write_note(&key, &with_provenance(&m.text, &m.sources)).await?;
        todo.extend(note.relationships().into_iter().map(|r| r.target));
        copied.push(key);
    }
    Ok(copied)
}

/// Copies every deck note that `text` (a note in `top`) references. Returns the keys copied.
pub async fn copy_up_refs(decks: &Decks<'_>, top: &dyn Storage, key: &str, text: &str) -> Result<Vec<String>> {
    let mut copied = Vec::new();
    for r in Note::parse(key, text).relationships() {
        copied.extend(copy_up(decks, top, &r.target).await?);
    }
    Ok(copied)
}

/// Brings `top` up to date with its decks: fast-forwards untouched copies whose merged deck text changed (an edit
/// upstream, or a deck holding the note mounted or unmounted), then copies in whatever `top` references but lacks.
/// A copy none of whose decks is mounted stays as it is. Run it when opening and after a sync.
pub async fn pull_upstream(decks: &Decks<'_>, top: &dyn Storage) -> Result<UpstreamReport> {
    let mut report = UpstreamReport::default();
    for (key, text) in top.read_all_notes().await? {
        let Some(p) = provenance(&text) else { continue };
        if !decks.decks.iter().any(|d| p.sources.contains(&d.source)) {
            continue;
        }
        let Some(m) = decks.read(&key).await? else { continue };
        let note = Note::parse(key.clone(), m.text.clone());
        let same_sources = p.sources.iter().copied().eq(m.sources.iter().map(String::as_str));
        if content_hash(normalized(&m.text).as_bytes()) == p.hash {
            decks.copy_blobs(top, &m, &note).await?; // heals an interrupted copy
            if !same_sources && p.untouched {
                top.write_note(&key, &with_provenance(&m.text, &m.sources)).await?;
            }
        } else if p.untouched {
            decks.copy_blobs(top, &m, &note).await?;
            top.write_note(&key, &with_provenance(&m.text, &m.sources)).await?;
            report.updated.push(key);
        } else {
            report.diverged.push(key);
        }
    }
    // each target once, however many notes reference it
    let targets: BTreeSet<String> =
        top.read_all_notes().await?.into_iter().flat_map(|(k, t)| Note::parse(k, t).relationships()).map(|r| r.target).collect();
    for key in targets {
        report.copied.extend(copy_up(decks, top, &key).await?);
    }
    Ok(report)
}

/// The keys of the notes in `top` copied from `sources` only (every deck in their trailer is one of them): what
/// "remove my data from this plugin" deletes.
pub async fn copies_of(top: &dyn Storage, sources: &[String]) -> Result<Vec<String>> {
    Ok(top
        .read_all_notes()
        .await?
        .into_iter()
        .filter(|(_, t)| provenance(t).is_some_and(|p| p.sources.iter().all(|s| sources.iter().any(|x| x == s))))
        .map(|(k, _)| k)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Memory;

    const CARD: &str = "id: c\ntitle: θρόνος\ntags: [pronunciation-card]\nblobs:\n- {label: audio, file: a.mp3}\n";
    const STATE: &str = "tags: [fsrs-state]\nrelationships:\n- {to: c, label: reviews}\n";

    async fn deck() -> Memory {
        let base = Memory::default();
        base.write_note("c", CARD).await.unwrap();
        base.write_note("other", "title: x\n").await.unwrap();
        base.write_blob("a.mp3", &[1]).await.unwrap();
        base
    }

    fn decks<'a>(g: &'a Gestalts, ds: &[(&'a str, &'a Memory)]) -> Decks<'a> {
        Decks { decks: ds.iter().map(|&(source, storage)| DeckRef { source, storage: storage as &dyn Storage }).collect(), gestalts: g }
    }

    fn sources(top_text: &str) -> Vec<String> {
        provenance(top_text).unwrap().sources.into_iter().map(str::to_owned).collect()
    }

    #[test]
    fn several_decks() {
        pollster::block_on(async {
            let g = Gestalts::builtin();
            let (a, b, top) = (deck().await, Memory::default(), Memory::default());
            b.write_note("w", "title: word\nrelationships: [c]\n").await.unwrap();
            let d = decks(&g, &[("p/a", &a), ("p/b", &b)]);
            top.write_note("s", "relationships: [{to: w, label: reviews}]\n").await.unwrap();
            let r = pull_upstream(&d, &top).await.unwrap();
            assert_eq!(r.copied.len(), 2);
            assert_eq!(sources(&top.read_note("w").await.unwrap().unwrap()), ["p/b"]);
            assert_eq!(sources(&top.read_note("c").await.unwrap().unwrap()), ["p/a"]);
        });
    }

    const KEN_WORLD: &str = "title: Kenya\ncode: KEN\ntags: [country]\npriority: 2\nrelationships:\n- {to: tza, label: distractor}\n- {to: ind, label: distractor}\n";
    const KEN_AFRICA: &str = "title: Kenya\ncode: KEN\ntags: [country]\npriority: 2\nrelationships:\n- {to: tza, label: distractor}\n- {to: uga, label: distractor}\n";

    #[test]
    fn decks_holding_the_same_key_merge() {
        pollster::block_on(async {
            let g = Gestalts::builtin();
            let (world, africa) = (Memory::default(), Memory::default());
            world.write_note("ken", KEN_WORLD).await.unwrap();
            africa.write_note("ken", KEN_AFRICA).await.unwrap();
            let m = decks(&g, &[("map/world", &world), ("map/africa", &africa)]).read("ken").await.unwrap().unwrap();
            // whatever the mount order, the same text
            let m2 = decks(&g, &[("map/africa", &africa), ("map/world", &world)]).read("ken").await.unwrap().unwrap();
            assert_eq!(m, m2);
            assert_eq!(m.sources, ["map/africa", "map/world"]);
            assert!(m.conflicts.is_empty());
            let note = Note::parse("ken", m.text);
            let mut targets: Vec<String> = note.relationships().into_iter().map(|r| r.target).collect();
            targets.sort();
            assert_eq!(targets, ["ind", "tza", "uga"]);
        });
    }

    #[test]
    fn a_value_decks_disagree_on_is_reported_and_settled_the_same_way() {
        pollster::block_on(async {
            let g = Gestalts::builtin();
            let (world, africa) = (Memory::default(), Memory::default());
            world.write_note("ken", KEN_WORLD).await.unwrap();
            africa.write_note("ken", &KEN_WORLD.replace("priority: 2", "priority: 1")).await.unwrap();
            let m = decks(&g, &[("map/world", &world), ("map/africa", &africa)]).read("ken").await.unwrap().unwrap();
            let m2 = decks(&g, &[("map/africa", &africa), ("map/world", &world)]).read("ken").await.unwrap().unwrap();
            assert_eq!(m.text, m2.text);
            assert_eq!(m.conflicts, ["ken: priority"]);
        });
    }

    #[test]
    fn a_copy_follows_when_a_deck_is_unmounted() {
        pollster::block_on(async {
            let g = Gestalts::builtin();
            let (world, africa, top) = (Memory::default(), Memory::default(), Memory::default());
            world.write_note("ken", KEN_WORLD).await.unwrap();
            africa.write_note("ken", KEN_AFRICA).await.unwrap();
            copy_up(&decks(&g, &[("map/world", &world), ("map/africa", &africa)]), &top, "ken").await.unwrap();
            let copy = top.read_note("ken").await.unwrap().unwrap();
            assert_eq!(sources(&copy), ["map/africa", "map/world"]);
            assert!(copy.contains("uga") && copy.contains("ind"));

            let r = pull_upstream(&decks(&g, &[("map/africa", &africa)]), &top).await.unwrap();
            assert_eq!(r.updated, ["ken"]);
            let copy = top.read_note("ken").await.unwrap().unwrap();
            assert_eq!(sources(&copy), ["map/africa"]);
            assert!(!copy.contains("ind"));
            assert_eq!(copies_of(&top, &["map/africa".into()]).await.unwrap(), ["ken"]);

            // neither of its decks mounted: left as it is
            let other = Memory::default();
            let r = pull_upstream(&decks(&g, &[("x/y", &other)]), &top).await.unwrap();
            assert_eq!(r, UpstreamReport::default());
        });
    }

    #[test]
    fn copies_of_takes_only_copies_from_those_decks_alone() {
        pollster::block_on(async {
            let top = Memory::default();
            top.write_note("a", &with_provenance("title: a\n", &["p/x".into()])).await.unwrap();
            top.write_note("b", &with_provenance("title: b\n", &["p/x".into(), "q/y".into()])).await.unwrap();
            assert_eq!(copies_of(&top, &["p/x".into()]).await.unwrap(), ["a"]);
            assert_eq!(copies_of(&top, &["p/x".into(), "q/y".into()]).await.unwrap(), ["a", "b"]);
        });
    }

    #[test]
    fn provenance_roundtrip() {
        let copy = with_provenance("title: x", &["p/d".into(), "p/e".into()]);
        assert!(copy.starts_with("title: x\nupstream:\n  sources: [p/d, p/e]\n  hash: "));
        let p = provenance(&copy).unwrap();
        assert_eq!((p.sources, p.untouched), (vec!["p/d", "p/e"], true));
        let edited = copy.replace("title: x", "title: y");
        assert!(!provenance(&edited).unwrap().untouched);
        assert_eq!(provenance("title: x\n"), None);
        assert_eq!(provenance(&format!("{copy}more: 1\n")), None);
    }

    #[test]
    fn closure_on_open_copies_referenced_notes_and_blobs() {
        pollster::block_on(async {
            let g = Gestalts::builtin();
            let (base, top) = (deck().await, Memory::default());
            top.write_note("s", STATE).await.unwrap();
            let d = decks(&g, &[("p/d", &base)]);
            let r = pull_upstream(&d, &top).await.unwrap();
            assert_eq!(r.copied, vec!["c"]);
            assert_eq!(top.list_notes().await.unwrap(), vec!["c", "s"]);
            assert_eq!(top.list_blobs().await.unwrap(), vec!["a.mp3"]);
            assert!(provenance(&top.read_note("c").await.unwrap().unwrap()).unwrap().untouched);
            // nothing changed upstream: a no-op
            assert_eq!(pull_upstream(&d, &top).await.unwrap(), UpstreamReport::default());
        });
    }

    #[test]
    fn untouched_copies_follow_upstream_edited_ones_diverge() {
        pollster::block_on(async {
            let g = Gestalts::builtin();
            let (base, top) = (deck().await, Memory::default());
            let d = decks(&g, &[("p/d", &base)]);
            copy_up(&d, &top, "c").await.unwrap();
            copy_up(&d, &top, "other").await.unwrap();
            let edited = top.read_note("other").await.unwrap().unwrap().replace("title: x", "title: mine");
            top.write_note("other", &edited).await.unwrap();

            base.write_note("c", &CARD.replace("a.mp3", "b.mp3")).await.unwrap();
            base.write_blob("b.mp3", &[2]).await.unwrap();
            base.write_note("other", "title: upstream\n").await.unwrap();

            let r = pull_upstream(&d, &top).await.unwrap();
            assert_eq!((r.updated, r.diverged), (vec!["c".to_owned()], vec!["other".to_owned()]));
            assert!(top.read_note("c").await.unwrap().unwrap().contains("b.mp3"));
            assert_eq!(top.read_blob("b.mp3").await.unwrap(), Some(vec![2]));
            assert_eq!(top.read_note("other").await.unwrap().as_deref(), Some(edited.as_str()));
        });
    }
}
