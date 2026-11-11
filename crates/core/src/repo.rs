//! A storage plus the index of its ymls: reading by query, writing with validation, and live queries.
//!
//! A live query is per subscription. When ymls change, only the subscriptions whose predicate matches an old or new
//! version of one of them are recomputed, and each gets a delta of its own page. Nothing else wakes up.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_yaml_ng::{Mapping, Value};

use crate::blobs::BlobRefs;
use crate::gestalt::{Edge, Gestalts, Problem, YmlState};
use crate::index::{Entry, Index, Item, Page, Query};
use crate::merge::tombstone;
use crate::storage::{Result, Storage, StorageError, check_key};
use crate::yml::{Yml, to_yaml};

pub type SubId = u64;

/// What changed in one subscription's page.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Delta {
    pub sub: SubId,
    /// items new to the page, or changed
    pub upsert: Vec<Item>,
    /// ids that left the page
    pub remove: Vec<String>,
    /// the page's ids, in order
    pub order: Vec<String>,
    pub next: Option<String>,
}

/// A yml that can't be used, and why.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Health {
    pub id: String,
    pub problems: Vec<Problem>,
}

struct Subscription {
    query: Query,
    window: Vec<String>,
    next: Option<String>,
}

pub struct Repo<S> {
    storage: S,
    gestalts: Gestalts,
    index: RefCell<Index>,
    subs: RefCell<BTreeMap<SubId, Subscription>>,
    next_sub: Cell<SubId>,
    deltas: RefCell<Vec<Delta>>,
}

type Changed = Vec<(String, Option<Entry>)>;

impl<S: Storage> Repo<S> {
    pub fn new(storage: S, gestalts: Gestalts) -> Self {
        Repo { storage, gestalts, index: RefCell::default(), subs: RefCell::default(), next_sub: Cell::new(1), deltas: RefCell::default() }
    }

    pub fn storage(&self) -> &S {
        &self.storage
    }

    pub fn gestalts(&self) -> &Gestalts {
        &self.gestalts
    }

    /// Reads every yml from storage. Happens once, on opening.
    pub async fn load(&self) -> Result<()> {
        let all = self.storage.read_all_ymls().await?;
        let mut changed: Changed = Vec::with_capacity(all.len());
        {
            let mut index = self.index.borrow_mut();
            let mut gone: BTreeSet<String> = index.entries().map(|e| e.yml.id.clone()).collect();
            for (id, raw) in all {
                gone.remove(&id);
                let old = index.insert(Entry::new(Yml::parse(id.clone(), raw), &self.gestalts));
                changed.push((id, old));
            }
            for id in gone {
                let old = index.remove(&id);
                changed.push((id, old));
            }
        }
        self.notify(changed);
        Ok(())
    }

    /// Rereads just `ids` from storage (after something wrote them behind the repo's back, like a sync or a hand
    /// edit); an id no longer in storage leaves the index.
    pub async fn reindex(&self, ids: &[String]) -> Result<()> {
        let mut changed: Changed = Vec::with_capacity(ids.len());
        for id in ids {
            let old = match self.storage.read_yml(id).await? {
                Some(raw) => self.index.borrow_mut().insert(Entry::new(Yml::parse(id.clone(), raw), &self.gestalts)),
                None => self.index.borrow_mut().remove(id),
            };
            changed.push((id.clone(), old));
        }
        self.notify(changed);
        Ok(())
    }

    /// The yml, if it's valid.
    pub fn get(&self, id: &str) -> Option<Item> {
        self.index.borrow().get(id)?.item(None)
    }

    /// One page of what `q` asks for.
    pub fn query(&self, q: &Query) -> Page {
        self.index.borrow().page(q)
    }

    /// Whether `id` is a tombstone.
    pub fn is_deleted(&self, id: &str) -> bool {
        self.index.borrow().get(id).is_some_and(|e| e.state == YmlState::Tombstone)
    }

    /// Every yml that can't be used, and why.
    pub fn health(&self) -> Vec<Health> {
        self.index
            .borrow()
            .entries()
            .filter_map(|e| match &e.state {
                YmlState::Invalid(problems) => Some(Health { id: e.yml.id.clone(), problems: problems.clone() }),
                _ => None,
            })
            .collect()
    }

    /// The blobs every indexed yml uses.
    pub fn blob_refs(&self) -> BlobRefs {
        let mut refs = BlobRefs::new();
        for e in self.index.borrow().entries() {
            refs.add(&e.yml, &e.state, &self.gestalts);
        }
        refs
    }

    /// Writes a yml, giving it a new uuid if it has no `id`. Anything not valid by its gestalt is refused, as is a
    /// reference to a yml of a gestalt the prop doesn't allow. A reference to nothing is fine: targets can be deleted.
    pub async fn put(&self, mut value: Value) -> Result<Item> {
        let Value::Mapping(m) = &mut value else { return Err(StorageError::Rejected("a yml must be a map".into())) };
        let id = m.get("id").and_then(Value::as_str).map_or_else(new_id, str::to_owned);
        check_key(&id)?;
        // `id` and `gestalt` lead, so the file reads well
        let mut ordered = Mapping::new();
        ordered.insert("id".into(), id.clone().into());
        if let Some(g) = m.get("gestalt") {
            ordered.insert("gestalt".into(), g.clone());
        }
        ordered.extend(std::mem::take(m).into_iter().filter(|(k, _)| !matches!(k.as_str(), Some("id" | "gestalt"))));
        let raw = to_yaml(&Value::Mapping(ordered));
        let entry = Entry::new(Yml::parse(id.clone(), raw.clone()), &self.gestalts);
        match &entry.state {
            YmlState::Valid(_) => {}
            YmlState::Unknown(g) => return Err(StorageError::Rejected(format!("no definition of {g} here"))),
            YmlState::Tombstone => return Err(StorageError::Rejected("a tombstone is written by deleting".into())),
            YmlState::Invalid(p) => return Err(StorageError::Rejected(serde_json::to_string(p).unwrap_or_default())),
        }
        self.check_targets(&entry.edges)?;
        self.storage.write_yml(&id, &raw).await?;
        let item = entry.item(None).ok_or_else(|| StorageError::Rejected("not valid".into()))?;
        self.replace(entry);
        Ok(item)
    }

    fn check_targets(&self, edges: &[Edge]) -> Result<()> {
        let index = self.index.borrow();
        for edge in edges.iter().filter(|e| !e.targets.is_empty()) {
            let Some(g) = index.get(&edge.target).and_then(Entry::gestalt) else { continue };
            let name = g.split('@').next().unwrap_or(g);
            if !edge.targets.iter().any(|t| t == name) {
                return Err(StorageError::Rejected(format!("{}: `{}` is a {name}, which it can't refer to", edge.field, edge.target)));
            }
        }
        Ok(())
    }

    /// Deletes a yml by writing its tombstone, dated `now` (an ISO datetime). Returns whether there was one to delete.
    pub async fn delete(&self, id: &str, now: &str) -> Result<bool> {
        let exists = self.index.borrow().get(id).is_some_and(|e| e.state != YmlState::Tombstone);
        if !exists {
            return Ok(false);
        }
        let raw = tombstone(id, now);
        self.storage.write_yml(id, &raw).await?;
        self.replace(Entry::new(Yml::parse(id, raw), &self.gestalts));
        Ok(true)
    }

    fn replace(&self, entry: Entry) {
        let id = entry.yml.id.clone();
        let old = self.index.borrow_mut().insert(entry);
        self.notify(vec![(id, old)]);
    }

    /// Starts a live query: its first page, and the id to [`Self::unsubscribe`] with.
    pub fn subscribe(&self, query: Query) -> (SubId, Page) {
        let page = self.query(&query);
        let id = self.next_sub.get();
        self.next_sub.set(id + 1);
        let window = page.items.iter().map(|i| i.id.clone()).collect();
        self.subs.borrow_mut().insert(id, Subscription { query, window, next: page.next.clone() });
        (id, page)
    }

    pub fn unsubscribe(&self, id: SubId) {
        self.subs.borrow_mut().remove(&id);
    }

    /// The deltas since last asked.
    pub fn take_deltas(&self) -> Vec<Delta> {
        std::mem::take(&mut self.deltas.borrow_mut())
    }

    /// Recomputes the subscriptions these changes concern. `changed` holds the previous version of each id.
    fn notify(&self, changed: Changed) {
        if changed.is_empty() || self.subs.borrow().is_empty() {
            return;
        }
        let index = self.index.borrow();
        let mut subs = self.subs.borrow_mut();
        for (&sub, s) in subs.iter_mut() {
            let touching: BTreeSet<&str> = changed
                .iter()
                .filter(|(id, old)| old.as_ref().is_some_and(|e| s.query.matches(e)) || index.get(id).is_some_and(|e| s.query.matches(e)))
                .map(|(id, _)| id.as_str())
                .collect();
            if touching.is_empty() {
                continue;
            }
            let page = index.page(&s.query);
            let order: Vec<String> = page.items.iter().map(|i| i.id.clone()).collect();
            let upsert: Vec<Item> = page.items.into_iter().filter(|i| touching.contains(i.id.as_str()) || !s.window.contains(&i.id)).collect();
            let remove: Vec<String> = s.window.iter().filter(|id| !order.contains(id)).cloned().collect();
            if upsert.is_empty() && remove.is_empty() && order == s.window && page.next == s.next {
                continue;
            }
            s.window = order.clone();
            s.next = page.next.clone();
            self.deltas.borrow_mut().push(Delta { sub, upsert, remove, order, next: page.next });
        }
    }
}

/// A fresh random uuid, for frontends that name new ymls themselves.
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// A stable uuid derived from a name, for deck generators and anything else that must be idempotent.
pub fn stable_id(namespace: &str, name: &str) -> String {
    let ns = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, namespace.as_bytes());
    uuid::Uuid::new_v5(&ns, name.as_bytes()).to_string()
}

/// The id of a learner-state yml (`fsrs-data`) for `target`, or for one `facet` of it, so two devices rating the same
/// thing write one yml. Ids can't contain `/`, so the joined name is unambiguous.
pub fn state_id(gestalt: &str, target: &str, facet: Option<&str>) -> String {
    match facet {
        Some(f) => stable_id(gestalt, &format!("{target}/{f}")),
        None => stable_id(gestalt, target),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::{Order, RefFilter, TagFilter};
    use crate::storage::Memory;
    use crate::yml::parse_yaml;

    const NOW: &str = "2026-11-04T10:00:00Z";

    fn repo() -> Repo<Memory> {
        Repo::new(Memory::default(), Gestalts::builtin())
    }

    fn note(id: &str, rest: &str) -> Value {
        parse_yaml(&format!("id: {id}\ngestalt: note@1\n{rest}")).unwrap()
    }

    fn notes() -> Query {
        Query { gestalt: Some("note@1".into()), ..Default::default() }
    }

    fn ids(p: &Page) -> Vec<&str> {
        p.items.iter().map(|i| i.id.as_str()).collect()
    }

    #[test]
    fn writes_are_validated() {
        pollster::block_on(async {
            let r = repo();
            let made = r.put(parse_yaml("gestalt: note@1\nmain: hi\n").unwrap()).await.unwrap();
            let text = r.storage().read_yml(&made.id).await.unwrap().unwrap();
            assert!(text.starts_with(&format!("id: {}\ngestalt: note@1\n", made.id)), "{text}");
            for bad in ["main: no gestalt\n", "gestalt: note@1\nfront: x\n", "gestalt: nothing-here@1\n", "id: a\ndeleted: 2026-01-01T00:00:00Z\n"] {
                let before = r.storage().list_ymls().await.unwrap().len();
                assert!(matches!(r.put(parse_yaml(bad).unwrap()).await, Err(StorageError::Rejected(_))), "{bad}");
                assert_eq!(r.storage().list_ymls().await.unwrap().len(), before);
            }
        });
    }

    #[test]
    fn references_must_be_to_an_allowed_gestalt() {
        pollster::block_on(async {
            let r = repo();
            r.put(parse_yaml("id: c\ngestalt: concept@1\nname: x\n").unwrap()).await.unwrap();
            r.put(note("n", "")).await.unwrap();
            assert!(r.put(note("m", "relationships: [{to: c, label: see}]\n")).await.is_err());
            r.put(note("m", "relationships: [{to: n, label: see}]\n")).await.unwrap();
            r.put(note("dangling", "relationships: [{to: nowhere, label: see}]\n")).await.unwrap();
        });
    }

    #[test]
    fn only_valid_ymls_are_queryable_and_the_rest_are_reported() {
        pollster::block_on(async {
            let r = repo();
            r.storage().write_yml("a", "id: a\ngestalt: note@1\n").await.unwrap();
            r.storage().write_yml("old", "tags: [flashcard]\nfront: x\n").await.unwrap();
            r.storage().write_yml("broken", "a: [x").await.unwrap();
            r.storage().write_yml("u", "id: u\ngestalt: from-a-plugin@1\n").await.unwrap();
            r.storage().write_yml("t", "id: t\ndeleted: 2026-01-01T00:00:00Z\n").await.unwrap();
            r.load().await.unwrap();
            assert_eq!(ids(&r.query(&Query::default())), vec!["a"]);
            assert_eq!(r.health().iter().map(|h| h.id.as_str()).collect::<Vec<_>>(), vec!["broken", "old"]);
            assert!(r.get("old").is_none() && r.get("u").is_none() && r.is_deleted("t"));
            assert!(!r.blob_refs().complete);
        });
    }

    #[test]
    fn delete_writes_a_tombstone_and_a_write_brings_it_back() {
        pollster::block_on(async {
            let r = repo();
            r.put(note("a", "")).await.unwrap();
            assert!(r.delete("a", NOW).await.unwrap());
            assert!(r.get("a").is_none() && r.is_deleted("a"));
            assert!(!r.delete("a", NOW).await.unwrap());
            r.put(note("a", "")).await.unwrap();
            assert!(r.get("a").is_some());
        });
    }

    #[test]
    fn filters_tags_refs_and_text() {
        pollster::block_on(async {
            let r = repo();
            r.put(note("a", "title: Κιννάμωμον spice\ntags: [x, no-queue]\n")).await.unwrap();
            r.put(note("b", "main: kept here\ntags: [x]\nrelationships: [{to: a, label: see}]\n")).await.unwrap();
            let q = |f: fn(&mut Query)| {
                let mut q = notes();
                f(&mut q);
                ids(&r.query(&q)).into_iter().map(str::to_owned).collect::<Vec<_>>()
            };
            assert_eq!(q(|q| q.tags = TagFilter { all: vec!["x".into()], none: vec!["no-queue".into()] }), vec!["b"]);
            assert_eq!(q(|q| q.refs = Some(RefFilter { to: "a".into(), field: None })), vec!["b"]);
            assert_eq!(q(|q| q.refs = Some(RefFilter { to: "a".into(), field: Some("other".into()) })), Vec::<String>::new());
            assert_eq!(q(|q| q.text = Some("κινναμ".into())), vec!["a"]);
            assert_eq!(q(|q| q.text = Some("KEPT he".into())), vec!["b"]);
            assert_eq!(q(|q| q.text = Some("kept spice".into())), Vec::<String>::new());
            assert_eq!(q(|q| q.ids = Some(vec!["b".into()])), vec!["b"]);
            assert_eq!(q(|q| { q.where_.insert("title".into(), "Κιννάμωμον spice".into()); }), vec!["a"]);
        });
    }

    #[test]
    fn a_sources_claims_are_found_through_the_reverse_index() {
        pollster::block_on(async {
            let r = repo();
            r.put(parse_yaml("id: s\ngestalt: source@1\nkey: k\nentrytype: misc\n").unwrap()).await.unwrap();
            r.put(parse_yaml("id: n1\ngestalt: note@1\nmain: a\nrelationships: [{to: s, label: source p. 3}]\n").unwrap()).await.unwrap();
            r.put(parse_yaml("id: n2\ngestalt: note@1\nmain: b\nrelationships: [{to: n1, label: see}]\n").unwrap()).await.unwrap();
            let q = Query { gestalt: Some("note@1".into()), refs: Some(RefFilter { to: "s".into(), field: Some("relationships".into()) }), ..Default::default() };
            assert_eq!(ids(&r.query(&q)), vec!["n1"]);
        });
    }

    #[test]
    fn a_concepts_practicers_are_found_through_the_reverse_index() {
        pollster::block_on(async {
            let r = repo();
            r.put(parse_yaml("id: f\ngestalt: flashcard@1\nfront: q\nconcepts: {c: 0.5}\n").unwrap()).await.unwrap();
            let q = Query { refs: Some(RefFilter { to: "c".into(), field: Some("concepts".into()) }), ..Default::default() };
            assert_eq!(ids(&r.query(&q)), vec!["f"]);
        });
    }

    #[test]
    fn pages_and_projections() {
        pollster::block_on(async {
            let r = repo();
            for i in 0..7 {
                r.put(note(&format!("n{i}"), &format!("title: t{}\nmain: body\n", 6 - i))).await.unwrap();
            }
            let mut q = Query { limit: Some(3), order: Some(Order::Field { field: "title".into(), desc: false }), fields: Some(vec!["title".into()]), ..notes() };
            let (mut seen, mut pages) = (Vec::new(), 0);
            loop {
                let p = r.query(&q);
                assert!(p.items.len() <= 3);
                pages += 1;
                seen.extend(p.items.iter().map(|i| i.id.clone()));
                assert!(p.items[0].value.get("main").is_none(), "not asked for");
                assert!(p.items[0].value.get("gestalt").is_some());
                match p.next {
                    Some(c) => q.cursor = Some(c),
                    None => break,
                }
            }
            assert_eq!(pages, 3);
            assert_eq!(seen, vec!["n6", "n5", "n4", "n3", "n2", "n1", "n0"]);
            let huge = r.query(&Query { limit: Some(1_000_000), ..notes() });
            assert_eq!(huge.items.len(), 7);
        });
    }

    #[test]
    fn numbers_sort_as_numbers_and_descending_pages_hold() {
        pollster::block_on(async {
            let r = repo();
            for (id, n) in [("a", 9), ("b", 10), ("c", 100)] {
                let v = parse_yaml(&format!("id: {id}\ngestalt: practice-session@1\napp: x\nstarted: 2026-01-01T00:00:00Z\ntrials: {n}\n")).unwrap();
                r.put(v).await.unwrap();
            }
            let mut q = Query { limit: Some(2), order: Some(Order::Field { field: "trials".into(), desc: true }), ..Default::default() };
            let p = r.query(&q);
            assert_eq!(ids(&p), vec!["c", "b"]);
            q.cursor = p.next;
            assert_eq!(ids(&r.query(&q)), vec!["a"]);
        });
    }

    #[test]
    fn a_random_order_is_stable_per_seed() {
        pollster::block_on(async {
            let r = repo();
            for i in 0..40 {
                r.put(note(&format!("n{i}"), "")).await.unwrap();
            }
            let q = |seed| Query { limit: Some(3), order: Some(Order::Random { seed }), ..notes() };
            assert_eq!(r.query(&q(1)), r.query(&q(1)));
            assert_ne!(r.query(&q(1)), r.query(&q(2)));
        });
    }

    #[test]
    fn deltas_say_what_changed_in_the_page() {
        pollster::block_on(async {
            let r = repo();
            r.put(note("a", "title: A\n")).await.unwrap();
            r.put(note("b", "title: B\n")).await.unwrap();
            let (sub, page) = r.subscribe(Query { limit: Some(2), tags: TagFilter { all: vec![], none: vec!["no-queue".into()] }, ..notes() });
            assert_eq!(ids(&page), vec!["a", "b"]);

            r.put(note("a", "title: A2\n")).await.unwrap();
            let d = r.take_deltas();
            assert_eq!(d.len(), 1);
            assert_eq!((d[0].sub, d[0].upsert.len(), d[0].upsert[0].id.as_str()), (sub, 1, "a"));
            assert!(d[0].remove.is_empty());

            // leaving by no longer matching: only an old version matches
            r.put(note("a", "tags: [no-queue]\n")).await.unwrap();
            let d = r.take_deltas();
            assert_eq!((d[0].remove.clone(), d[0].order.clone()), (vec!["a".to_owned()], vec!["b".to_owned()]));

            // past the end of a full page: the page holds the same ids, only `next` changes
            r.put(note("c", "")).await.unwrap();
            r.take_deltas();
            r.put(note("d", "")).await.unwrap();
            let d = r.take_deltas();
            assert_eq!(d.len(), 1);
            assert!(d[0].upsert.is_empty() && d[0].remove.is_empty() && d[0].next.is_some());

            r.unsubscribe(sub);
            r.put(note("e", "")).await.unwrap();
            assert!(r.take_deltas().is_empty());
        });
    }

    #[test]
    fn a_sync_or_hand_edit_reaches_subscriptions_through_reindex() {
        pollster::block_on(async {
            let r = repo();
            r.put(note("a", "")).await.unwrap();
            let (_, _) = r.subscribe(notes());
            r.storage().write_yml("b", "id: b\ngestalt: note@1\n").await.unwrap();
            r.reindex(&["b".into()]).await.unwrap();
            assert_eq!(r.take_deltas()[0].order, vec!["a", "b"]);
            r.storage().write_yml("b", "not: a note\n").await.unwrap();
            r.reindex(&["b".into()]).await.unwrap();
            assert_eq!(r.take_deltas()[0].remove, vec!["b"]);
        });
    }

    /// The requirement in change.md, as a test: one change in 12k ymls wakes only who it concerns.
    #[test]
    fn one_change_among_12k_ymls_wakes_only_matching_subscriptions() {
        pollster::block_on(async {
            let r = repo();
            for i in 0..12_000 {
                r.storage().write_yml(&format!("n{i}"), &format!("id: n{i}\ngestalt: note@1\nmain: word{i}\n")).await.unwrap();
            }
            r.load().await.unwrap();
            let page_limit = 20;
            let (notes_sub, first) = r.subscribe(Query { limit: Some(page_limit), ..notes() });
            assert_eq!(first.items.len(), page_limit);
            let (concepts_sub, _) = r.subscribe(Query { gestalt: Some("concept@1".into()), ..Default::default() });
            let (word_sub, _) = r.subscribe(Query { text: Some("uniquely".into()), ..notes() });

            // inside the first page, and matches nothing else
            r.put(note("n0", "main: edited\n")).await.unwrap();
            let d = r.take_deltas();
            assert_eq!(d.iter().map(|x| x.sub).collect::<Vec<_>>(), vec![notes_sub]);
            assert_eq!(d[0].upsert.len(), 1, "a delta, not the page");

            // a concept: note queries sleep
            r.put(parse_yaml("id: c\ngestalt: concept@1\nname: x\n").unwrap()).await.unwrap();
            let d = r.take_deltas();
            assert_eq!(d.iter().map(|x| x.sub).collect::<Vec<_>>(), vec![concepts_sub]);

            // matches the text query only; outside the notes page, which therefore stays the same and sends nothing
            r.put(note("n9999", "main: uniquely now\n")).await.unwrap();
            let d = r.take_deltas();
            assert_eq!(d.iter().map(|x| x.sub).collect::<Vec<_>>(), vec![word_sub]);
        });
    }

    #[test]
    fn stable_ids() {
        assert_eq!(stable_id("x", "δελφίς"), stable_id("x", "δελφίς"));
        assert_ne!(stable_id("x", "a"), stable_id("x", "b"));
        assert_eq!(state_id("fsrs-data", "c", None), stable_id("fsrs-data", "c"));
        assert_eq!(state_id("fsrs-data", "c", Some("level:2")), stable_id("fsrs-data", "c/level:2"));
    }
}
