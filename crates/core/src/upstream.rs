//! Copy-on-write from a read-only upstream (a shipped deck) into the user's own storage.
//!
//! - User space is closed under references: a note there whose `relationships` point at a note that
//!   only exists upstream gets that note copied in, with its blobs (and, in turn, its references).
//! - Every copy is the upstream text plus a provenance trailer (`upstream: {source, hash}`), so a
//!   copy the user never edited can be fast-forwarded when upstream changes.

use std::collections::BTreeSet;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::note::Note;
use crate::storage::{Result, Storage};

/// Hex sha256, used for provenance and content-addressed blob names.
pub fn content_hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

const TRAILER_START: &str = "upstream:\n  source: ";

/// The upstream text as copies start with it: ending in a newline, so the trailer can follow.
fn normalized(base: &str) -> String {
    let mut s = base.to_owned();
    if !s.is_empty() && !s.ends_with('\n') {
        s.push('\n');
    }
    s
}

/// `base` as copied into user space: the upstream text with the provenance trailer appended.
pub fn with_provenance(base: &str, source: &str) -> String {
    let body = normalized(base);
    let hash = content_hash(body.as_bytes());
    format!("{body}{TRAILER_START}{source}\n  hash: {hash}\n")
}

/// Where a copy came from, read off its trailer.
#[derive(Debug, PartialEq)]
pub struct Provenance<'a> {
    pub source: &'a str,
    pub hash: &'a str,
    /// whether the text before the trailer is still exactly what was copied
    pub untouched: bool,
}

/// `None` if `text` doesn't end in a provenance trailer.
pub fn provenance(text: &str) -> Option<Provenance<'_>> {
    let at = text.rmatch_indices(TRAILER_START).map(|(i, _)| i).find(|&i| i == 0 || text[..i].ends_with('\n'))?;
    let (body, rest) = text.split_at(at);
    let mut lines = rest[TRAILER_START.len()..].strip_suffix('\n')?.split('\n');
    let source = lines.next()?;
    let hash = lines.next()?.strip_prefix("  hash: ")?;
    if lines.next().is_some() {
        return None;
    }
    Some(Provenance { source, hash, untouched: content_hash(body.as_bytes()) == hash })
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
}

/// A read-only deck as copy-on-write sees it: its `source` id (and earlier ids, `aliases`) and its notes.
#[derive(Clone, Copy)]
pub struct DeckRef<'a> {
    pub source: &'a str,
    pub aliases: &'a [String],
    pub storage: &'a dyn Storage,
}

impl DeckRef<'_> {
    /// Whether a copy with this `source` in its trailer came from this deck.
    pub fn is_source(&self, source: &str) -> bool {
        self.source == source || self.aliases.iter().any(|a| a == source)
    }
}

/// The first deck that has `key`, with its text.
async fn find<'a>(decks: &[DeckRef<'a>], key: &str) -> Result<Option<(DeckRef<'a>, String)>> {
    for d in decks {
        if let Some(text) = d.storage.read_note(key).await? {
            return Ok(Some((*d, text)));
        }
    }
    Ok(None)
}

/// Copies `key` (and whatever it references) from the deck that has it into `top`, unless `top` has it already (a
/// tombstone there counts: a deleted copy isn't copied back). Returns the keys copied.
pub async fn copy_up(decks: &[DeckRef<'_>], top: &dyn Storage, key: &str) -> Result<Vec<String>> {
    let mut copied = Vec::new();
    let mut seen = BTreeSet::new();
    let mut todo = vec![key.to_owned()];
    while let Some(key) = todo.pop() {
        if !seen.insert(key.clone()) || top.read_note(&key).await?.is_some() {
            continue;
        }
        let Some((deck, text)) = find(decks, &key).await? else { continue };
        let note = Note::parse(key.clone(), text.clone());
        copy_blobs(deck.storage, top, &note).await?;
        top.write_note(&key, &with_provenance(&text, deck.source)).await?;
        todo.extend(note.relationships().into_iter().map(|r| r.target));
        copied.push(key);
    }
    Ok(copied)
}

/// Copies every deck note that `text` (a note in `top`) references. Returns the keys copied.
pub async fn copy_up_refs(decks: &[DeckRef<'_>], top: &dyn Storage, key: &str, text: &str) -> Result<Vec<String>> {
    let mut copied = Vec::new();
    for r in Note::parse(key, text).relationships() {
        copied.extend(copy_up(decks, top, &r.target).await?);
    }
    Ok(copied)
}

async fn copy_blobs(base: &dyn Storage, top: &dyn Storage, note: &Note) -> Result<()> {
    for b in note.blobs() {
        if top.read_blob(&b.target).await?.is_none()
            && let Some(bytes) = base.read_blob(&b.target).await?
        {
            top.write_blob(&b.target, &bytes).await?;
        }
    }
    Ok(())
}

/// Brings `top` up to date with its decks: fast-forwards untouched copies whose deck note changed (a copy made under
/// one of a deck's aliases follows it too, and takes its current id), then copies in whatever `top` references but
/// lacks. Run it when opening and after a sync.
pub async fn pull_upstream(decks: &[DeckRef<'_>], top: &dyn Storage) -> Result<UpstreamReport> {
    let mut report = UpstreamReport::default();
    for (key, text) in top.read_all_notes().await? {
        let Some(p) = provenance(&text) else { continue };
        let Some(deck) = decks.iter().find(|d| d.is_source(p.source)) else { continue };
        let Some(base_text) = deck.storage.read_note(&key).await? else { continue };
        let note = Note::parse(key.clone(), base_text.clone());
        if content_hash(normalized(&base_text).as_bytes()) == p.hash {
            copy_blobs(deck.storage, top, &note).await?; // heals an interrupted copy
        } else if p.untouched {
            copy_blobs(deck.storage, top, &note).await?;
            top.write_note(&key, &with_provenance(&base_text, deck.source)).await?;
            report.updated.push(key);
        } else {
            report.diverged.push(key);
        }
    }
    for (key, text) in top.read_all_notes().await? {
        report.copied.extend(copy_up_refs(decks, top, &key, &text).await?);
    }
    Ok(report)
}

/// The keys of the notes in `top` copied from the deck `source` (or one of its `aliases`): what "remove my data from
/// this plugin" deletes.
pub async fn copies_of(top: &dyn Storage, source: &str, aliases: &[String]) -> Result<Vec<String>> {
    let deck = DeckRef { source, aliases, storage: top };
    Ok(top.read_all_notes().await?.into_iter().filter(|(_, t)| provenance(t).is_some_and(|p| deck.is_source(p.source))).map(|(k, _)| k).collect())
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

    fn one(base: &Memory) -> Vec<DeckRef<'_>> {
        vec![DeckRef { source: "demo", aliases: &[], storage: base }]
    }

    #[test]
    fn copies_made_under_an_alias_follow_the_deck() {
        pollster::block_on(async {
            let (base, top) = (deck().await, Memory::default());
            copy_up(&one(&base), &top, "c").await.unwrap();
            base.write_note("c", &CARD.replace("θρόνος", "θρόνοι")).await.unwrap();
            let aliases = ["demo".to_owned()];
            let decks = [DeckRef { source: "greek-alphabet", aliases: &aliases, storage: &base }];
            let r = pull_upstream(&decks, &top).await.unwrap();
            assert_eq!(r.updated, vec!["c"]);
            let copy = top.read_note("c").await.unwrap().unwrap();
            assert_eq!(provenance(&copy).unwrap().source, "greek-alphabet");
            assert_eq!(copies_of(&top, "greek-alphabet", &aliases).await.unwrap(), vec!["c"]);
        });
    }

    #[test]
    fn several_decks() {
        pollster::block_on(async {
            let (a, b, top) = (deck().await, Memory::default(), Memory::default());
            b.write_note("w", "title: word\nrelationships: [c]\n").await.unwrap();
            let decks = [DeckRef { source: "a", aliases: &[], storage: &a }, DeckRef { source: "b", aliases: &[], storage: &b }];
            top.write_note("s", "relationships: [{to: w, label: reviews}]\n").await.unwrap();
            let r = pull_upstream(&decks, &top).await.unwrap();
            assert_eq!(r.copied.len(), 2);
            assert_eq!(provenance(&top.read_note("w").await.unwrap().unwrap()).unwrap().source, "b");
            assert_eq!(provenance(&top.read_note("c").await.unwrap().unwrap()).unwrap().source, "a");
        });
    }

    #[test]
    fn provenance_roundtrip() {
        let copy = with_provenance("title: x", "demo");
        assert!(copy.starts_with("title: x\nupstream:\n  source: demo\n  hash: "));
        let p = provenance(&copy).unwrap();
        assert_eq!((p.source, p.untouched), ("demo", true));
        let edited = copy.replace("title: x", "title: y");
        assert!(!provenance(&edited).unwrap().untouched);
        assert_eq!(provenance("title: x\n"), None);
        assert_eq!(provenance(&format!("{copy}more: 1\n")), None);
    }

    #[test]
    fn closure_on_open_copies_referenced_notes_and_blobs() {
        pollster::block_on(async {
            let (base, top) = (deck().await, Memory::default());
            top.write_note("s", STATE).await.unwrap();
            let r = pull_upstream(&one(&base), &top).await.unwrap();
            assert_eq!(r.copied, vec!["c"]);
            assert_eq!(top.list_notes().await.unwrap(), vec!["c", "s"]);
            assert_eq!(top.list_blobs().await.unwrap(), vec!["a.mp3"]);
            assert!(provenance(&top.read_note("c").await.unwrap().unwrap()).unwrap().untouched);
            // nothing changed upstream: a no-op
            assert_eq!(pull_upstream(&one(&base), &top).await.unwrap(), UpstreamReport::default());
        });
    }

    #[test]
    fn untouched_copies_follow_upstream_edited_ones_diverge() {
        pollster::block_on(async {
            let (base, top) = (deck().await, Memory::default());
            copy_up(&one(&base), &top, "c").await.unwrap();
            copy_up(&one(&base), &top, "other").await.unwrap();
            let edited = top.read_note("other").await.unwrap().unwrap().replace("title: x", "title: mine");
            top.write_note("other", &edited).await.unwrap();

            base.write_note("c", &CARD.replace("a.mp3", "b.mp3")).await.unwrap();
            base.write_blob("b.mp3", &[2]).await.unwrap();
            base.write_note("other", "title: upstream\n").await.unwrap();

            let r = pull_upstream(&one(&base), &top).await.unwrap();
            assert_eq!((r.updated, r.diverged), (vec!["c".to_owned()], vec!["other".to_owned()]));
            assert!(top.read_note("c").await.unwrap().unwrap().contains("b.mp3"));
            assert_eq!(top.read_blob("b.mp3").await.unwrap(), Some(vec![2]));
            assert_eq!(top.read_note("other").await.unwrap().as_deref(), Some(edited.as_str()));
        });
    }
}
