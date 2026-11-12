//! An outline over labelled references, the way Luhmann's Zettelkasten is one: each yml says where it goes by one
//! reference, either `follows` X (next after X in X's sequence) or `branches` from X (starts a sequence under X). One
//! yml tagged `root_tag` starts it all; `exclude_tag` keeps a yml out without placing it. Nothing is stored: the
//! outline is worked out from the index, so whatever wrote the ymls (a view, a sync, a hand edit), it shows what is.
//!
//! Every yml of the gestalt has a [`Status`]. What doesn't add up is said with [`Mark`]s rather than hidden:
//!
//! - The root is the lowest id tagged `root_tag`; any other so tagged is an `extraRoot`, and a root that also
//!   references a place is `rootPlaced` (the reference is ignored).
//! - A yml's place is its first structural reference; more than one is `placedTwice`.
//! - A placed yml whose places don't lead to the root is `floating`. The first of each floating chain says why: its
//!   place is missing (not a yml of the gestalt), unplaced or excluded, or the chain is a cycle (marked on its lowest id).
//! - Several ymls following, or branching from, one yml are a `fork`, marked on all but the first by id; all are shown.
//! - A yml tagged `exclude_tag` that is placed anyway is `excludedPlaced`, and placed.
//!
//! Shown as rows: the top level is the root, then its sequence; under a yml, the sequence branching from it. A
//! sequence lists each yml followed by what follows it, depth first, so forks keep their followers together.
//!
//! Keeping up: only a change to what places a yml (its structural references, those two tags, it appearing or going)
//! marks the outline stale; the next read rebuilds it, in one pass over the ymls of the gestalt.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use crate::index::{DEFAULT_LIMIT, Entry, Index, Item, MAX_LIMIT};

/// What makes an outline: which ymls, through which prop, and the labels and tags that mean something.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutlineSpec {
    /// `name@version`
    pub gestalt: String,
    /// the `relationships` prop holding the places
    pub field: String,
    /// the label of "next after"
    pub follows: String,
    /// the label of "starts a sequence under"
    pub branches: String,
    pub root_tag: String,
    pub exclude_tag: String,
}

/// What a view asks an outline.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Ask {
    /// the rows under a yml, or the top level for `null`
    Children(Option<String>),
    /// a yml and what follows it, as rows: what hangs on a floating yml, say
    Sequence(String),
    /// where each of these ymls is (ids that aren't ymls of the gestalt are left out)
    Locate(Vec<String>),
    /// every yml with a mark, by id
    Loose,
}

/// One ask of one outline, a bounded page at a time.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutlineQuery {
    pub spec: OutlineSpec,
    pub ask: Ask,
    /// 100 when not given, 500 at most
    #[serde(default)]
    pub limit: Option<usize>,
    /// the `next` of the page before
    #[serde(default)]
    pub cursor: Option<String>,
    /// only these props (with `id` and `gestalt`, always)
    #[serde(default)]
    pub fields: Option<Vec<String>>,
    /// for `locate`: say of each yml whether it is placed below this one (so placing this one there makes a cycle)
    #[serde(default)]
    pub subject: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Root,
    /// its places lead to the root
    Attached,
    /// placed, but its places don't lead to the root
    Floating,
    /// not placed, not excluded: waiting to be
    Unplaced,
    Excluded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MarkKind {
    /// the first of a floating chain: its place isn't a yml of the gestalt
    ParentMissing,
    /// the first of a floating chain: its place isn't placed
    ParentUnplaced,
    /// the first of a floating chain: its place is excluded
    ParentExcluded,
    /// the lowest id of a cycle of places
    Cycle,
    PlacedTwice,
    /// not the first to follow, or branch from, `target`
    Fork,
    ExtraRoot,
    RootPlaced,
    ExcludedPlaced,
}

/// Something that doesn't add up about a yml; `target` is the place it concerns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Mark {
    pub kind: MarkKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

/// A yml in an outline. `path` (for `locate`) is where it is shown: from the top level down to the yml it's under.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineEntry {
    pub item: Item,
    pub status: Status,
    /// whether a sequence branches from it
    pub has_children: bool,
    pub marks: Vec<Mark>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<Vec<Item>>,
    /// for `locate` with a `subject`: whether its places lead through the subject (or it is the subject)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub below_subject: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OutlinePage {
    pub entries: Vec<OutlineEntry>,
    /// the cursor of the next page; `None` on the last
    pub next: Option<String>,
}

impl OutlinePage {
    /// Every id the page shows, for knowing which changes concern it.
    pub fn ids(&self) -> BTreeSet<String> {
        self.entries.iter().flat_map(|e| std::iter::once(&e.item).chain(e.path.iter().flatten())).map(|i| i.id.clone()).collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Follows,
    Branches,
}

/// What places one yml.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct Inputs {
    places: Vec<(Kind, String)>,
    root_tag: bool,
    excluded: bool,
}

impl Inputs {
    fn of(spec: &OutlineSpec, e: &Entry) -> Option<Self> {
        if e.gestalt() != Some(spec.gestalt.as_str()) {
            return None;
        }
        let places = e
            .edges
            .iter()
            .filter(|edge| edge.field == spec.field)
            .filter_map(|edge| match edge.label.as_deref() {
                Some(l) if l == spec.follows => Some((Kind::Follows, edge.target.clone())),
                Some(l) if l == spec.branches => Some((Kind::Branches, edge.target.clone())),
                _ => None,
            })
            .collect();
        Some(Inputs { places, root_tag: e.tags().any(|t| t == spec.root_tag), excluded: e.tags().any(|t| t == spec.exclude_tag) })
    }
}

/// One outline, rebuilt when stale.
pub struct Outline {
    spec: OutlineSpec,
    stale: bool,
    nodes: HashMap<String, Inputs>,
    /// each yml's place: its first structural reference, none for the root
    place: HashMap<String, (Kind, String)>,
    after: HashMap<String, Vec<String>>,
    under: HashMap<String, Vec<String>>,
    root: Option<String>,
    status: HashMap<String, Status>,
    marks: BTreeMap<String, Vec<Mark>>,
}

impl Outline {
    pub fn new(spec: OutlineSpec) -> Self {
        Outline {
            spec,
            stale: true,
            nodes: HashMap::new(),
            place: HashMap::new(),
            after: HashMap::new(),
            under: HashMap::new(),
            root: None,
            status: HashMap::new(),
            marks: BTreeMap::new(),
        }
    }

    pub fn spec(&self) -> &OutlineSpec {
        &self.spec
    }

    /// Takes note of a changed yml; whether it changes the outline.
    pub fn observe(&mut self, old: Option<&Entry>, new: Option<&Entry>) -> bool {
        let (before, after) = (old.and_then(|e| Inputs::of(&self.spec, e)), new.and_then(|e| Inputs::of(&self.spec, e)));
        if before == after {
            return false;
        }
        self.stale = true;
        true
    }

    fn mark(&mut self, id: &str, kind: MarkKind, target: Option<&str>) {
        self.marks.entry(id.to_owned()).or_default().push(Mark { kind, target: target.map(str::to_owned) });
    }

    fn catch_up(&mut self, index: &Index) {
        if !self.stale {
            return;
        }
        self.stale = false;
        self.nodes = index.of_gestalt(&self.spec.gestalt).filter_map(|e| Some((e.yml.id.clone(), Inputs::of(&self.spec, e)?))).collect();
        let mut ids: Vec<String> = self.nodes.keys().cloned().collect();
        ids.sort();
        self.marks.clear();
        self.root = ids.iter().find(|id| self.nodes[*id].root_tag).cloned();
        self.place.clear();
        for id in &ids {
            let n = &self.nodes[id];
            let is_root = self.root.as_ref() == Some(id);
            let (root_tag, excluded, places) = (n.root_tag, n.excluded, n.places.clone());
            if root_tag && !is_root {
                self.mark(id, MarkKind::ExtraRoot, None);
            }
            if places.is_empty() {
                continue;
            }
            if is_root {
                self.mark(id, MarkKind::RootPlaced, None);
                continue;
            }
            if places.len() > 1 {
                self.mark(id, MarkKind::PlacedTwice, None);
            }
            if excluded {
                self.mark(id, MarkKind::ExcludedPlaced, None);
            }
            self.place.insert(id.clone(), places[0].clone());
        }
        // ids are walked in order, so each list is by id
        self.after.clear();
        self.under.clear();
        for id in &ids {
            if let Some((kind, target)) = self.place.get(id) {
                let list = if *kind == Kind::Follows { &mut self.after } else { &mut self.under };
                list.entry(target.clone()).or_default().push(id.clone());
            }
        }
        let forks: Vec<(String, String)> = self
            .after
            .iter()
            .chain(&self.under)
            .flat_map(|(target, list)| list.iter().skip(1).map(move |id| (id.clone(), target.clone())))
            .collect();
        for (id, target) in forks {
            self.mark(&id, MarkKind::Fork, Some(&target));
        }
        self.settle(&ids);
    }

    /// Works out every status, and why each floating chain floats.
    fn settle(&mut self, ids: &[String]) {
        self.status.clear();
        for id in ids {
            if self.place.contains_key(id) {
                continue;
            }
            let n = &self.nodes[id];
            let s = if self.root.as_ref() == Some(id) {
                Status::Root
            } else if n.root_tag {
                Status::Floating
            } else if n.excluded {
                Status::Excluded
            } else {
                Status::Unplaced
            };
            self.status.insert(id.clone(), s);
        }
        // follows places up until a settled yml, a missing one, or one already on the way (a cycle)
        for id in ids {
            if self.status.contains_key(id) {
                continue;
            }
            let (mut path, mut on_path): (Vec<String>, HashMap<String, usize>) = (Vec::new(), HashMap::new());
            let mut cur = id.clone();
            let attached = loop {
                if let Some(s) = self.status.get(&cur) {
                    break matches!(s, Status::Root | Status::Attached);
                }
                if let Some(&at) = on_path.get(&cur) {
                    let lowest = path[at..].iter().min().cloned().unwrap_or_default();
                    let target = self.place[&lowest].1.clone();
                    self.mark(&lowest, MarkKind::Cycle, Some(&target));
                    break false;
                }
                let Some((_, target)) = self.place.get(&cur) else { break false };
                on_path.insert(cur.clone(), path.len());
                path.push(cur.clone());
                cur = target.clone();
            };
            for p in path {
                self.status.insert(p, if attached { Status::Attached } else { Status::Floating });
            }
        }
        let heads: Vec<(String, MarkKind, String)> = self
            .place
            .iter()
            .filter(|(id, _)| self.status[*id] == Status::Floating)
            .filter_map(|(id, (_, target))| {
                let kind = match self.status.get(target) {
                    None => MarkKind::ParentMissing,
                    Some(Status::Unplaced) => MarkKind::ParentUnplaced,
                    Some(Status::Excluded) => MarkKind::ParentExcluded,
                    _ => return None,
                };
                Some((id.clone(), kind, target.clone()))
            })
            .collect();
        for (id, kind, target) in heads {
            self.mark(&id, kind, Some(&target));
        }
    }

    /// The sequence starting with `heads`: each, then what follows it, depth first. Never loops.
    fn sequence(&self, heads: &[String]) -> Vec<String> {
        let (mut out, mut seen) = (Vec::new(), BTreeSet::new());
        let mut stack: Vec<&String> = heads.iter().rev().collect();
        while let Some(id) = stack.pop() {
            if !seen.insert(id) {
                continue;
            }
            out.push(id.clone());
            stack.extend(self.after.get(id).into_iter().flatten().rev());
        }
        out
    }

    /// Where `id` is shown: the ymls it's under, from the top level down.
    fn path(&self, id: &str) -> Vec<String> {
        let (mut out, mut seen) = (Vec::new(), BTreeSet::new());
        let mut cur = id.to_owned();
        while seen.insert(cur.clone()) {
            match self.place.get(&cur) {
                Some((Kind::Follows, target)) => cur = target.clone(),
                Some((Kind::Branches, target)) if self.nodes.contains_key(target) => {
                    out.push(target.clone());
                    cur = target.clone();
                }
                _ => break,
            }
        }
        out.reverse();
        out
    }

    /// Whether `id` is `subject`, or its places lead through it.
    fn below(&self, id: &str, subject: &str) -> bool {
        let (mut cur, mut seen) = (id, BTreeSet::new());
        while seen.insert(cur) {
            if cur == subject {
                return true;
            }
            match self.place.get(cur) {
                Some((_, target)) => cur = target,
                None => break,
            }
        }
        false
    }

    fn entry(&self, index: &Index, id: &str, fields: Option<&[String]>) -> Option<OutlineEntry> {
        Some(OutlineEntry {
            item: index.get(id)?.item(fields)?,
            status: *self.status.get(id)?,
            has_children: self.under.get(id).is_some_and(|l| !l.is_empty()),
            marks: self.marks.get(id).cloned().unwrap_or_default(),
            path: None,
            below_subject: None,
        })
    }

    /// One page of what `q` asks (its spec must be this outline's).
    pub fn answer(&mut self, index: &Index, q: &OutlineQuery) -> OutlinePage {
        self.catch_up(index);
        let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
        let fields = q.fields.as_deref();
        let ids: Vec<String> = match &q.ask {
            Ask::Children(None) => self.sequence(self.root.as_slice()),
            Ask::Children(Some(of)) => self.sequence(self.under.get(of).map(Vec::as_slice).unwrap_or_default()),
            Ask::Sequence(from) => self.sequence(std::slice::from_ref(from)),
            Ask::Locate(ids) => ids.clone(),
            Ask::Loose => self.marks.keys().cloned().collect(),
        };
        let start = q.cursor.as_deref().and_then(|c| c.parse::<usize>().ok()).unwrap_or(0).min(ids.len());
        let end = (start + limit).min(ids.len());
        let entries = ids[start..end]
            .iter()
            .filter_map(|id| {
                let mut e = self.entry(index, id, fields)?;
                if matches!(q.ask, Ask::Locate(_)) {
                    e.path = Some(self.path(id).iter().filter_map(|p| index.get(p)?.item(fields)).collect());
                    e.below_subject = q.subject.as_deref().map(|s| self.below(id, s));
                }
                Some(e)
            })
            .collect();
        OutlinePage { entries, next: (end < ids.len()).then(|| end.to_string()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gestalt::Gestalts;
    use crate::yml::Yml;

    fn spec() -> OutlineSpec {
        OutlineSpec {
            gestalt: "note@1".into(),
            field: "relationships".into(),
            follows: "follows".into(),
            branches: "branches from".into(),
            root_tag: "zettelkasten-root".into(),
            exclude_tag: "no-zettelkasten".into(),
        }
    }

    /// `(id, rest of the yml)`
    fn index(notes: &[(&str, &str)]) -> Index {
        let g = Gestalts::builtin();
        let mut index = Index::default();
        for (id, rest) in notes {
            index.insert(Entry::new(Yml::parse(*id, format!("id: {id}\ngestalt: note@1\n{rest}")), &g));
        }
        index
    }

    fn ask(o: &mut Outline, index: &Index, ask: Ask) -> Vec<(String, Status, Vec<MarkKind>)> {
        let q = OutlineQuery { spec: spec(), ask, limit: Some(500), cursor: None, fields: None, subject: None };
        o.answer(index, &q).entries.into_iter().map(|e| (e.item.id, e.status, e.marks.into_iter().map(|m| m.kind).collect())).collect()
    }

    fn ids(rows: &[(String, Status, Vec<MarkKind>)]) -> Vec<&str> {
        rows.iter().map(|r| r.0.as_str()).collect()
    }

    const F: &str = "follows";
    const B: &str = "branches from";
    fn at(label: &str, to: &str) -> String {
        format!("relationships: [{{to: {to}, label: {label}}}]\n")
    }

    #[test]
    fn sequences_and_branches() {
        let (a2, a3, b1, b2, c1) = (at(F, "a1"), at(F, "a2"), at(B, "a1"), at(F, "b1"), at(B, "b1"));
        let index = index(&[("a1", "tags: [zettelkasten-root]\n"), ("a2", &a2), ("a3", &a3), ("b1", &b1), ("b2", &b2), ("c1", &c1), ("u", "")]);
        let mut o = Outline::new(spec());
        let top = ask(&mut o, &index, Ask::Children(None));
        assert_eq!(ids(&top), vec!["a1", "a2", "a3"]);
        assert_eq!(top[0].1, Status::Root);
        assert_eq!(ids(&ask(&mut o, &index, Ask::Children(Some("a1".into())))), vec!["b1", "b2"]);
        assert_eq!(ids(&ask(&mut o, &index, Ask::Children(Some("b1".into())))), vec!["c1"]);
        assert!(ask(&mut o, &index, Ask::Loose).is_empty());
        let q = OutlineQuery { spec: spec(), ask: Ask::Locate(vec!["c1".into(), "u".into(), "nope".into()]), limit: None, cursor: None, fields: None, subject: None };
        let located = o.answer(&index, &q).entries;
        assert_eq!(located.len(), 2);
        assert_eq!(located[0].path.as_ref().unwrap().iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), vec!["a1", "b1"]);
        assert_eq!((located[0].status, located[1].status), (Status::Attached, Status::Unplaced));
        assert!(o.answer(&index, &OutlineQuery { ask: Ask::Children(None), ..q.clone() }).entries[0].has_children);
        let mut below = |subject: &str, id: &str| {
            let q = OutlineQuery { ask: Ask::Locate(vec![id.into()]), subject: Some(subject.into()), ..q.clone() };
            o.answer(&index, &q).entries[0].below_subject
        };
        assert_eq!((below("a1", "c1"), below("b1", "c1"), below("b1", "a3"), below("u", "u")), (Some(true), Some(true), Some(false), Some(true)));
    }

    #[test]
    fn forks_stay_together_depth_first() {
        let (x, y, x2) = (at(F, "r"), at(F, "r"), at(F, "x"));
        let index = index(&[("r", "tags: [zettelkasten-root]\n"), ("x", &x), ("y", &y), ("x2", &x2)]);
        let mut o = Outline::new(spec());
        let top = ask(&mut o, &index, Ask::Children(None));
        assert_eq!(ids(&top), vec!["r", "x", "x2", "y"]);
        assert_eq!(top[3].2, vec![MarkKind::Fork]);
    }

    #[test]
    fn what_floats_says_why() {
        let rows = [
            ("r", "tags: [zettelkasten-root]\n".to_owned()),
            ("gone1", at(F, "nowhere")),
            ("gone2", at(F, "gone1")),
            ("on-u", at(B, "u")),
            ("u", String::new()),
            ("on-x", at(F, "x")),
            ("x", "tags: [no-zettelkasten]\n".into()),
            ("c1", at(F, "c2")),
            ("c2", at(F, "c1")),
            ("r2", "tags: [zettelkasten-root]\n".into()),
            ("on-r2", at(F, "r2")),
            ("twice", "relationships: [{to: r, label: follows}, {to: u, label: branches from}]\n".into()),
            ("ex-placed", format!("tags: [no-zettelkasten]\n{}", at(F, "twice"))),
        ];
        let rows: Vec<(&str, &str)> = rows.iter().map(|(a, b)| (*a, b.as_str())).collect();
        let index = index(&rows);
        let mut o = Outline::new(spec());
        let loose = ask(&mut o, &index, Ask::Loose);
        let got: Vec<(&str, Status, Vec<MarkKind>)> = loose.iter().map(|(id, s, m)| (id.as_str(), *s, m.clone())).collect();
        use MarkKind::*;
        assert_eq!(
            got,
            vec![
                ("c1", Status::Floating, vec![Cycle]),
                ("ex-placed", Status::Attached, vec![ExcludedPlaced]),
                ("gone1", Status::Floating, vec![ParentMissing]),
                ("on-u", Status::Floating, vec![ParentUnplaced]),
                ("on-x", Status::Floating, vec![ParentExcluded]),
                ("r2", Status::Floating, vec![ExtraRoot]),
                ("twice", Status::Attached, vec![PlacedTwice]),
            ]
        );
        let located = o.answer(&index, &OutlineQuery { spec: spec(), ask: Ask::Locate(vec!["gone2".into(), "on-r2".into(), "x".into()]), limit: None, cursor: None, fields: None, subject: None });
        assert_eq!(located.entries.iter().map(|e| e.status).collect::<Vec<_>>(), vec![Status::Floating, Status::Floating, Status::Excluded]);
        // a floating chain is browsable from its first
        let mut o = Outline::new(spec());
        assert_eq!(ids(&ask(&mut o, &index, Ask::Children(Some("u".into())))), vec!["on-u"]);
        assert_eq!(ids(&ask(&mut o, &index, Ask::Sequence("gone1".into()))), vec!["gone1", "gone2"]);
        assert_eq!(ids(&ask(&mut o, &index, Ask::Sequence("c1".into()))), vec!["c1", "c2"], "a cycle ends");
    }

    #[test]
    fn the_lowest_root_wins_and_a_placed_root_ignores_its_place() {
        let r = format!("tags: [zettelkasten-root]\n{}", at(F, "s"));
        let index = index(&[("r", &r), ("s", ""), ("z", "tags: [zettelkasten-root]\n")]);
        let mut o = Outline::new(spec());
        let top = ask(&mut o, &index, Ask::Children(None));
        assert_eq!(top, vec![("r".to_owned(), Status::Root, vec![MarkKind::RootPlaced])]);
        assert_eq!(ask(&mut o, &index, Ask::Loose).len(), 2);
    }

    #[test]
    fn long_chains_and_pages() {
        let mut rows = vec![("n00000".to_owned(), "tags: [zettelkasten-root]\n".to_owned())];
        for i in 1..20_000 {
            rows.push((format!("n{i:05}"), at(F, &format!("n{:05}", i - 1))));
        }
        let rows: Vec<(&str, &str)> = rows.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        let index = index(&rows);
        let mut o = Outline::new(spec());
        let mut q = OutlineQuery { spec: spec(), ask: Ask::Children(None), limit: Some(500), cursor: None, fields: Some(vec![]), subject: None };
        let mut seen = 0;
        loop {
            let p = o.answer(&index, &q);
            seen += p.entries.len();
            match p.next {
                Some(c) => q.cursor = Some(c),
                None => break,
            }
        }
        assert_eq!(seen, 20_000);
        let located = o.answer(&index, &OutlineQuery { ask: Ask::Locate(vec!["n19999".into()]), cursor: None, ..q });
        assert_eq!(located.entries[0].status, Status::Attached);
    }

    #[test]
    fn only_what_places_a_yml_makes_it_stale() {
        let g = Gestalts::builtin();
        let e = |rest: &str| Entry::new(Yml::parse("a", format!("id: a\ngestalt: note@1\n{rest}")), &g);
        let mut o = Outline::new(spec());
        o.stale = false;
        assert!(!o.observe(Some(&e("title: x\n")), Some(&e("title: y\n"))));
        assert!(!o.observe(Some(&e(&at("see", "b"))), Some(&e(""))));
        assert!(o.observe(Some(&e("")), Some(&e(&at(F, "b")))));
        assert!(o.observe(None, Some(&e(""))));
    }
}
