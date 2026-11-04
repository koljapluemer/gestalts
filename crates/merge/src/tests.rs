use proptest::prelude::*;
use serde_yaml_ng::{Mapping, Value};

use super::*;

fn y(s: &str) -> Value {
    serde_yaml_ng::from_str(s).unwrap()
}

fn m(p: &Policy, b: Option<&str>, l: Option<&str>, r: Option<&str>) -> Outcome {
    let (b, l, r) = (b.map(y), l.map(y), r.map(y));
    merge(p, b.as_ref(), l.as_ref(), r.as_ref())
}

fn policy(s: &str) -> Policy {
    Policy::parse(&y(s)).unwrap()
}

// ---- examples ----

#[test]
fn map_merges_per_key_and_recurses() {
    let o = m(&Policy::map(), Some("{a: 1, n: {x: 1, y: 1}}"), Some("{a: 2, n: {x: 2, y: 1}}"), Some("{a: 1, n: {x: 1, y: 3}, c: 4}"));
    assert_eq!(o.value, Some(y("{a: 2, n: {x: 2, y: 3}, c: 4}")));
    assert!(o.conflicts.is_empty());
}

#[test]
fn conflicts_keep_the_greater_side_whichever_is_local() {
    let o = m(&Policy::map(), Some("{a: 1}"), Some("{a: 2}"), Some("{a: 3}"));
    assert_eq!(o.value, Some(y("{a: 3}")));
    assert_eq!(o.conflicts, vec![Conflict { path: vec![Segment::Key("a".into())], base: Some(y("1")), kept: Some(y("3")), lost: Some(y("2")) }]);
    assert_eq!(m(&Policy::map(), Some("{a: 1}"), Some("{a: 3}"), Some("{a: 2}")), o);
    // an edit beats a removed key, and the removal is reported
    let o = m(&Policy::map(), Some("{a: 1}"), Some("{}"), Some("{a: 2}"));
    assert_eq!(o.value, Some(y("{a: 2}")));
    assert_eq!(o.conflicts[0].lost, None);
}

#[test]
fn sets() {
    let p = Policy::Set;
    assert_eq!(m(&p, Some("[a]"), Some("[a, b]"), Some("[a, c]")).value, Some(y("[a, c, b]")));
    assert_eq!(m(&p, Some("[x, y]"), Some("[y]"), Some("[x, y, z]")).value, Some(y("[y, z]")));
    assert_eq!(m(&p, Some("[x]"), None, Some("[x, y]")).value, Some(y("[y]")));
    assert_eq!(m(&p, Some("[x, y]"), None, Some("[x]")).value, None);
}

#[test]
fn union_by_keeps_every_item_in_order() {
    let p = policy("union_by: at");
    let o = m(&p, Some("[{at: 1}]"), Some("[{at: 1}, {at: 3, x: l}]"), Some("[{at: 1}, {at: 2, x: r}]"));
    assert_eq!(o.value, Some(y("[{at: 1}, {at: 2, x: r}, {at: 3, x: l}]")));
    // removals don't count once both changed
    let o = m(&p, Some("[{at: 1}, {at: 2}]"), Some("[{at: 2}, {at: 3}]"), Some("[{at: 1}, {at: 2}, {at: 4}]"));
    assert_eq!(o.value, Some(y("[{at: 1}, {at: 2}, {at: 3}, {at: 4}]")));
}

#[test]
fn list_by_merges_each_item() {
    let p = policy("list_by: id");
    let o = m(
        &p,
        Some("[{id: a, front: x, back: y}, {id: b, front: q, back: r}]"),
        Some("[{id: a, front: X, back: y}, {id: b, front: q, back: r}, {id: c, front: n, back: n}]"),
        Some("[{id: a, front: x, back: Y}]"),
    );
    assert_eq!(o.value, Some(y("[{id: a, front: X, back: Y}, {id: c, front: n, back: n}]")));
    assert!(o.conflicts.is_empty());
}

#[test]
fn text_merges_lines() {
    let s = |t: &str| Some(Value::String(t.into()));
    let o = merge(&Policy::Text, s("1\n2\n3\n4\n").as_ref(), s("one\n2\n3\n4\n").as_ref(), s("1\n2\n3\nfour\n").as_ref());
    assert_eq!(o.value, s("one\n2\n3\nfour\n"));
    let o = merge(&Policy::Text, s("1\n").as_ref(), s("l\n").as_ref(), s("r\n").as_ref());
    assert_eq!(o.conflicts.len(), 1);
}

#[test]
fn newest_by_without_a_base() {
    let p = policy("newest_by: [card.lastReviewAt, card.reps]");
    let older = "{card: {lastReviewAt: '2026-01-01T10:00:00Z', reps: 5}, x: 1}";
    let newer = "{card: {lastReviewAt: '2026-01-02T10:00:00Z', reps: 1}, x: 2}";
    assert_eq!(m(&p, None, Some(older), Some(newer)).value, Some(y(newer)));
    assert_eq!(m(&p, None, Some(newer), Some(older)).value, Some(y(newer)));
    let more = "{card: {lastReviewAt: '2026-01-01T10:00:00Z', reps: 6}, x: 3}";
    assert_eq!(m(&p, None, Some(older), Some(more)).value, Some(y(more)));
    assert!(m(&p, None, Some(older), Some(more)).conflicts.is_empty());
}

#[test]
fn max_and_min() {
    assert_eq!(m(&Policy::Max, Some("1"), Some("5"), Some("3")).value, Some(y("5")));
    assert_eq!(m(&Policy::Min, Some("9"), Some("5"), Some("3")).value, Some(y("3")));
    assert_eq!(m(&Policy::Max, Some("'2026-01-01T00:00Z'"), Some("'2026-02-01T00:00Z'"), Some("'2026-01-05T00:00Z'")).value, Some(y("'2026-02-01T00:00Z'")));
}

#[test]
fn parsing_and_combining() {
    let p = policy("keys: {events: {union_by: at}, active_ms: max}");
    assert_eq!(p, Policy::Map([("events".into(), Policy::UnionBy("at".into())), ("active_ms".into(), Policy::Max)].into()));
    assert_eq!(policy("whole: {newest_by: [card.lastReviewAt]}"), Policy::NewestBy(vec![vec!["card".into(), "lastReviewAt".into()]]));
    assert!(Policy::parse(&y("sometimes")).is_err());
    assert!(Policy::parse(&y("{union_by: at, extra: 1}")).is_err());
    let a = policy("keys: {x: max, y: set}");
    let b = policy("keys: {x: max, y: text, z: min}");
    assert_eq!(a.combine(&b), policy("keys: {x: max, y: conflict, z: min}"));
    assert_eq!(Policy::Max.combine(&a), Policy::Conflict);
    let default = policy("keys: {tags: set, main: text}");
    assert_eq!(default.overlay(&policy("keys: {main: max}")), policy("keys: {tags: set, main: max}"));
    assert_eq!(default.overlay(&Policy::Max), Policy::Max);
}

// ---- laws ----

fn leaf() -> impl Strategy<Value = Value> {
    prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        (0i64..4).prop_map(|n| Value::Number(n.into())),
        prop::sample::select(vec!["x", "y", "z", "a\nb\n", "a\nc\n"]).prop_map(|s| Value::String(s.into())),
    ]
}

fn value() -> impl Strategy<Value = Value> {
    leaf().prop_recursive(3, 16, 3, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..3).prop_map(Value::Sequence),
            prop::collection::btree_map(prop::sample::select(vec!["a", "b", "c"]), inner, 0..3).prop_map(|m| {
                Value::Mapping(m.into_iter().map(|(k, v)| (Value::String(k.into()), v)).collect::<Mapping>())
            }),
        ]
    })
}

fn side() -> impl Strategy<Value = Option<Value>> {
    prop::option::weighted(0.9, value())
}

fn item_list(field: &'static str) -> impl Strategy<Value = Option<Value>> {
    let item = (0i64..4, prop::sample::select(vec!["p", "q"])).prop_map(move |(id, v)| {
        let mut m = Mapping::new();
        m.insert(Value::String(field.into()), Value::Number(id.into()));
        m.insert(Value::String("v".into()), Value::String(v.into()));
        Value::Mapping(m)
    });
    prop::option::weighted(0.9, prop::collection::vec(item, 0..4).prop_map(Value::Sequence))
}

fn policies() -> impl Strategy<Value = Policy> {
    prop::sample::select(vec![
        Policy::Conflict,
        Policy::map(),
        Policy::Set,
        Policy::Text,
        Policy::Max,
        Policy::Min,
        Policy::UnionBy("id".into()),
        Policy::ListBy { field: "id".into(), item: Box::new(Policy::map()) },
        Policy::NewestBy(vec![vec!["a".into()], vec!["b".into()]]),
    ])
}

/// `side()` for most policies; lists of items for the ones that need them, so their own code runs.
fn sides_for(p: &Policy) -> BoxedStrategy<Option<Value>> {
    match p {
        Policy::UnionBy(_) | Policy::ListBy { .. } => item_list("id").boxed(),
        _ => side().boxed(),
    }
}

fn case() -> impl Strategy<Value = (Policy, Option<Value>, Option<Value>, Option<Value>)> {
    policies().prop_flat_map(|p| {
        let s = sides_for(&p);
        (Just(p), s.clone(), s.clone(), s)
    })
}

fn same(a: &Outcome, b: &Outcome) -> bool {
    a.value.as_ref().map(canonical) == b.value.as_ref().map(canonical) && a.conflicts == b.conflicts
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    #[test]
    fn identity((p, x, _, _) in case()) {
        let o = merge(&p, x.as_ref(), x.as_ref(), x.as_ref());
        prop_assert_eq!(o.value, x);
        prop_assert!(o.conflicts.is_empty());
    }

    #[test]
    fn one_side_changed((p, b, x, _) in case()) {
        let o = merge(&p, b.as_ref(), b.as_ref(), x.as_ref());
        prop_assert_eq!(&o.value, &x);
        prop_assert!(o.conflicts.is_empty());
        let o = merge(&p, b.as_ref(), x.as_ref(), b.as_ref());
        prop_assert_eq!(&o.value, &x);
    }

    #[test]
    fn idempotent((p, b, x, _) in case()) {
        let o = merge(&p, b.as_ref(), x.as_ref(), x.as_ref());
        prop_assert_eq!(o.value, x);
        prop_assert!(o.conflicts.is_empty());
    }

    #[test]
    fn symmetric((p, b, l, r) in case()) {
        let x = merge(&p, b.as_ref(), l.as_ref(), r.as_ref());
        let y = merge(&p, b.as_ref(), r.as_ref(), l.as_ref());
        prop_assert!(same(&x, &y), "{:?}\n{:?}", x, y);
    }

    /// Under `map`, a change on either side is in the result, or a conflict says where it went.
    #[test]
    fn no_silent_loss(b in side(), l in side(), r in side()) {
        let o = merge(&Policy::map(), b.as_ref(), l.as_ref(), r.as_ref());
        check_kept(&o, &mut vec![], b.as_ref(), l.as_ref(), o.value.as_ref())?;
        check_kept(&o, &mut vec![], b.as_ref(), r.as_ref(), o.value.as_ref())?;
    }

    #[test]
    fn sets_keep_additions_and_drop_removals(b in prop::collection::vec(0u8..6, 0..5), l in prop::collection::vec(0u8..6, 0..5), r in prop::collection::vec(0u8..6, 0..5)) {
        let seq = |v: &[u8]| Value::Sequence(v.iter().map(|n| Value::Number((*n as i64).into())).collect());
        let o = merge(&Policy::Set, Some(&seq(&b)), Some(&seq(&l)), Some(&seq(&r)));
        let out: Vec<u8> = o.value.as_ref().and_then(Value::as_sequence).map(|s| s.iter().map(|v| v.as_i64().unwrap() as u8).collect()).unwrap_or_default();
        for i in l.iter().chain(&r) {
            if !b.contains(i) { prop_assert!(out.contains(i)); }
        }
        for i in &b {
            if !l.contains(i) || !r.contains(i) { prop_assert!(!out.contains(i)); }
        }
    }

    #[test]
    fn max_is_at_least_both(b in 0i64..10, l in 0i64..10, r in 0i64..10) {
        let n = |x: i64| Value::Number(x.into());
        let o = merge(&Policy::Max, Some(&n(b)), Some(&n(l)), Some(&n(r)));
        let v = o.value.unwrap().as_i64().unwrap();
        if l != b && r != b { prop_assert_eq!(v, l.max(r)); } else { prop_assert!(v == l || v == r); }
    }

    #[test]
    fn union_by_keeps_every_id(b in item_list("id"), l in item_list("id"), r in item_list("id")) {
        let o = merge(&Policy::UnionBy("id".into()), b.as_ref(), l.as_ref(), r.as_ref());
        let ids = |v: Option<&Value>| -> Vec<Value> { v.and_then(Value::as_sequence).map(|s| s.iter().map(|i| i["id"].clone()).collect()).unwrap_or_default() };
        let valid = |v: Option<&Value>| v.and_then(Value::as_sequence).is_none_or(|s| { let ids: Vec<_> = s.iter().map(|i| &i["id"]).collect(); ids.iter().enumerate().all(|(n, i)| !ids[..n].contains(i)) });
        if l != b && r != b && l != r && valid(b.as_ref()) && valid(l.as_ref()) && valid(r.as_ref()) {
            let out = ids(o.value.as_ref());
            for id in ids(l.as_ref()).into_iter().chain(ids(r.as_ref())) { prop_assert!(out.contains(&id)); }
        }
    }

    #[test]
    fn text_keeps_both_edits_apart(a in 0usize..3, b in 3usize..6, la in "[a-z]{1,3}", rb in "[A-Z]{1,3}") {
        let base: Vec<String> = (0..6).map(|i| i.to_string()).collect();
        let mut l = base.clone(); l[a] = la.clone();
        let mut r = base.clone(); r[b] = rb.clone();
        let s = |v: &[String]| Value::String(v.join("\n") + "\n");
        let o = merge(&Policy::Text, Some(&s(&base)), Some(&s(&l)), Some(&s(&r)));
        let mut both = base.clone(); both[a] = la; both[b] = rb;
        if b > a + 1 { prop_assert_eq!(o.value, Some(s(&both))); }
    }
}

/// Every leaf where `side` differs from `base` reads the same in `out`, or a conflict covers its path.
fn check_kept(o: &Outcome, path: &mut Vec<Segment>, base: Option<&Value>, side: Option<&Value>, out: Option<&Value>) -> Result<(), TestCaseError> {
    if side == base || side == out {
        return Ok(());
    }
    let covered = o.conflicts.iter().any(|c| path.starts_with(&c.path) && (c.lost.as_ref() == side || c.kept.as_ref() == side || c.path.len() <= path.len()));
    if covered {
        return Ok(());
    }
    if let (Some(Value::Mapping(s)), Some(Value::Mapping(out_m))) = (side, out) {
        let empty = Mapping::new();
        let bm = base.and_then(Value::as_mapping).unwrap_or(&empty);
        let keys: Vec<Value> = s.keys().chain(bm.keys()).cloned().collect();
        for k in keys {
            path.push(Segment::Key(k.as_str().unwrap().to_owned()));
            check_kept(o, path, bm.get(&k), s.get(&k), out_m.get(&k))?;
            path.pop();
        }
        return Ok(());
    }
    Err(TestCaseError::fail(format!("change at {path:?} lost: {side:?} vs {out:?}\n{o:?}")))
}
