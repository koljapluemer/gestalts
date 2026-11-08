//! The in-memory index of a repo's ymls and the query language over it.
//!
//! A query walks only the smallest set an index can give it, and always answers one bounded page. Views never hold
//! the index; they get pages and deltas ([`crate::repo`]).

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};
use serde_yaml_ng::{Mapping, Value};
use unicode_normalization::UnicodeNormalization;

use crate::gestalt::{Edge, Gestalts, YmlState};
use crate::yml::Yml;

/// A page without a `limit` holds this many.
pub const DEFAULT_LIMIT: usize = 100;
/// No page holds more than this.
pub const MAX_LIMIT: usize = 500;

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct TagFilter {
    pub all: Vec<String>,
    pub none: Vec<String>,
}

/// Ymls that reference `to`, through the prop `field` if given.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RefFilter {
    pub to: String,
    #[serde(default)]
    pub field: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields, untagged)]
pub enum Order {
    /// a stable shuffle: the same seed gives the same order
    Random { seed: u32 },
    /// by a top-level prop; ymls without it sort first (last when `desc`)
    Field {
        field: String,
        #[serde(default)]
        desc: bool,
    },
}

/// Which ymls a view wants. All given conditions must hold.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Query {
    /// `name@version`
    pub gestalt: Option<String>,
    pub ids: Option<Vec<String>>,
    /// exact matches on top-level props
    #[serde(rename = "where")]
    pub where_: BTreeMap<String, Value>,
    pub tags: TagFilter,
    pub refs: Option<RefFilter>,
    /// every word must start a word of the yml's text; case and diacritics don't matter
    pub text: Option<String>,
    /// by id when not given
    pub order: Option<Order>,
    pub limit: Option<usize>,
    /// the `next` of the page before
    pub cursor: Option<String>,
    /// only these props (with `id` and `gestalt`, always)
    pub fields: Option<Vec<String>>,
}

/// A yml as views get it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Item {
    pub id: String,
    pub gestalt: String,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Page {
    pub items: Vec<Item>,
    /// the cursor of the next page; `None` on the last
    pub next: Option<String>,
}

/// One indexed yml.
#[derive(Debug, Clone)]
pub struct Entry {
    pub yml: Yml,
    pub state: YmlState,
    pub edges: Vec<Edge>,
    tokens: BTreeSet<String>,
}

impl Entry {
    pub fn new(yml: Yml, gestalts: &Gestalts) -> Self {
        let state = gestalts.classify(&yml);
        let (mut edges, mut tokens) = (Vec::new(), BTreeSet::new());
        if let (YmlState::Valid(g), Some(m)) = (&state, yml.map())
            && let Some(def) = gestalts.get(g)
        {
            edges = def.edges(m);
            def.searchable(m).into_iter().for_each(|t| tokens.extend(words(t)));
        }
        Entry { yml, state, edges, tokens }
    }

    pub fn gestalt(&self) -> Option<&str> {
        match &self.state {
            YmlState::Valid(g) => Some(g),
            _ => None,
        }
    }

    fn tags(&self) -> impl Iterator<Item = &str> {
        self.yml.get("tags").and_then(Value::as_sequence).into_iter().flatten().filter_map(Value::as_str)
    }

    fn has_word(&self, prefix: &str) -> bool {
        self.tokens.range(prefix.to_owned()..).next().is_some_and(|t| t.starts_with(prefix))
    }

    pub fn item(&self, fields: Option<&[String]>) -> Option<Item> {
        let gestalt = self.gestalt()?.to_owned();
        let value = match (fields, self.yml.map()) {
            (Some(fields), Some(m)) => {
                let keep = |k: &str| matches!(k, "id" | "gestalt") || fields.iter().any(|f| f == k);
                let projected: Mapping = m.iter().filter(|(k, _)| k.as_str().is_some_and(keep)).map(|(k, v)| (k.clone(), v.clone())).collect();
                Value::Mapping(projected)
            }
            _ => self.yml.value.clone()?,
        };
        Some(Item { id: self.yml.id.clone(), gestalt, value })
    }
}

/// Lowercased words with diacritics removed, for any script.
pub fn words(text: &str) -> impl Iterator<Item = String> + '_ {
    let folded: String = text.nfd().filter(|c| !unicode_normalization::char::is_combining_mark(*c)).flat_map(char::to_lowercase).collect();
    folded.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_owned).collect::<Vec<_>>().into_iter()
}

impl Query {
    /// Whether `e` is one the query asks for, regardless of paging.
    pub fn matches(&self, e: &Entry) -> bool {
        let Some(gestalt) = e.gestalt() else { return false };
        self.gestalt.as_deref().is_none_or(|g| g == gestalt)
            && self.ids.as_ref().is_none_or(|ids| ids.contains(&e.yml.id))
            && self.where_.iter().all(|(k, v)| e.yml.get(k) == Some(v))
            && self.tags.all.iter().all(|t| e.tags().any(|have| have == t))
            && !self.tags.none.iter().any(|t| e.tags().any(|have| have == t))
            && self.refs.as_ref().is_none_or(|r| e.edges.iter().any(|edge| edge.target == r.to && r.field.as_ref().is_none_or(|f| *f == edge.field)))
            && self.text.as_deref().is_none_or(|t| words(t).all(|w| e.has_word(&w)))
    }

    fn sort_key(&self, e: &Entry) -> Value {
        match &self.order {
            None => Value::Null,
            Some(Order::Field { field, .. }) => e.yml.get(field).cloned().unwrap_or(Value::Null),
            Some(Order::Random { seed }) => crate::yml::content_hash(format!("{seed}:{}", e.yml.id).as_bytes()).into(),
        }
    }

    fn descending(&self) -> bool {
        matches!(self.order, Some(Order::Field { desc: true, .. }))
    }
}

fn compare(a: &Value, b: &Value) -> Ordering {
    match (a, b) {
        (Value::Null, Value::Null) => Ordering::Equal,
        (Value::Null, _) => Ordering::Less,
        (_, Value::Null) => Ordering::Greater,
        (Value::Number(x), Value::Number(y)) => x.as_f64().partial_cmp(&y.as_f64()).unwrap_or(Ordering::Equal),
        _ => gestalts_merge::canonical(a).cmp(&gestalts_merge::canonical(b)),
    }
}

#[derive(Default)]
pub struct Index {
    entries: BTreeMap<String, Entry>,
    by_gestalt: HashMap<String, BTreeSet<String>>,
    by_tag: HashMap<String, BTreeSet<String>>,
    backrefs: HashMap<String, BTreeSet<String>>,
    by_word: BTreeMap<String, BTreeSet<String>>,
}

impl Index {
    pub fn get(&self, id: &str) -> Option<&Entry> {
        self.entries.get(id)
    }

    pub fn entries(&self) -> impl Iterator<Item = &Entry> {
        self.entries.values()
    }

    /// Puts `e` in, returning what it replaced.
    pub fn insert(&mut self, e: Entry) -> Option<Entry> {
        let old = self.remove(&e.yml.id);
        let id = e.yml.id.clone();
        if let Some(g) = e.gestalt() {
            self.by_gestalt.entry(g.to_owned()).or_default().insert(id.clone());
            for t in e.tags() {
                self.by_tag.entry(t.to_owned()).or_default().insert(id.clone());
            }
            for edge in &e.edges {
                self.backrefs.entry(edge.target.clone()).or_default().insert(id.clone());
            }
            for w in &e.tokens {
                self.by_word.entry(w.clone()).or_default().insert(id.clone());
            }
        }
        self.entries.insert(id, e);
        old
    }

    pub fn remove(&mut self, id: &str) -> Option<Entry> {
        let e = self.entries.remove(id)?;
        fn drop_from(map: &mut HashMap<String, BTreeSet<String>>, key: &str, id: &str) {
            if let Some(set) = map.get_mut(key) {
                set.remove(id);
                if set.is_empty() {
                    map.remove(key);
                }
            }
        }
        if let Some(g) = e.gestalt() {
            drop_from(&mut self.by_gestalt, g, id);
            e.tags().for_each(|t| drop_from(&mut self.by_tag, t, id));
            e.edges.iter().for_each(|edge| drop_from(&mut self.backrefs, &edge.target, id));
            for w in &e.tokens {
                if let Some(set) = self.by_word.get_mut(w) {
                    set.remove(id);
                    if set.is_empty() {
                        self.by_word.remove(w);
                    }
                }
            }
        }
        Some(e)
    }

    /// The ids holding a word that starts with `prefix`.
    fn with_word(&self, prefix: &str) -> BTreeSet<String> {
        self.by_word.range(prefix.to_owned()..).take_while(|(w, _)| w.starts_with(prefix)).flat_map(|(_, ids)| ids.iter().cloned()).collect()
    }

    /// The smallest set of ids the indexes say the answer lies within, `None` when none applies.
    fn narrowed(&self, q: &Query) -> Option<BTreeSet<String>> {
        let empty = BTreeSet::new;
        let mut sets: Vec<BTreeSet<String>> = Vec::new();
        if let Some(ids) = &q.ids {
            sets.push(ids.iter().cloned().collect());
        }
        if let Some(g) = &q.gestalt {
            sets.push(self.by_gestalt.get(g).cloned().unwrap_or_else(empty));
        }
        if let Some(t) = q.tags.all.first() {
            sets.push(self.by_tag.get(t).cloned().unwrap_or_else(empty));
        }
        if let Some(r) = &q.refs {
            sets.push(self.backrefs.get(&r.to).cloned().unwrap_or_else(empty));
        }
        if let Some(w) = q.text.as_deref().and_then(|t| words(t).next()) {
            sets.push(self.with_word(&w));
        }
        sets.into_iter().min_by_key(BTreeSet::len)
    }

    /// One page of what `q` asks for.
    pub fn page(&self, q: &Query) -> Page {
        let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
        let matching: Vec<&Entry> = match self.narrowed(q) {
            Some(ids) => ids.iter().filter_map(|id| self.entries.get(id)).filter(|e| q.matches(e)).collect(),
            None => self.entries.values().filter(|e| q.matches(e)).collect(),
        };
        let mut keyed: Vec<(Value, &Entry)> = matching.into_iter().map(|e| (q.sort_key(e), e)).collect();
        let desc = q.descending();
        let cmp = |ak: &Value, aid: &str, bk: &Value, bid: &str| {
            let by_key = compare(ak, bk);
            (if desc { by_key.reverse() } else { by_key }).then_with(|| aid.cmp(bid))
        };
        keyed.sort_by(|(ak, a), (bk, b)| cmp(ak, &a.yml.id, bk, &b.yml.id));
        let after: Option<(Value, String)> = q.cursor.as_deref().and_then(|c| serde_json::from_str(c).ok());
        let start = after.map_or(0, |(k, id)| keyed.partition_point(|(ak, a)| cmp(ak, &a.yml.id, &k, &id) != Ordering::Greater));
        let rest = &keyed[start..];
        let window = &rest[..rest.len().min(limit)];
        let next = (rest.len() > limit)
            .then(|| window.last())
            .flatten()
            .and_then(|(k, e)| serde_json::to_string(&(k, &e.yml.id)).ok());
        let fields = q.fields.as_deref();
        Page { items: window.iter().filter_map(|(_, e)| e.item(fields)).collect(), next }
    }
}
