use super::*;

const NOW: &str = "2026-11-04T10:00:00Z";

fn m(b: Option<&str>, l: Option<&str>, r: Option<&str>) -> YmlMerge {
    let g = Gestalts::builtin();
    let x = merge_yml("k", b, l, r, &g, NOW);
    // symmetric, whichever side is local
    assert_eq!(x, merge_yml("k", b, r, l, &g, NOW), "not symmetric");
    x
}

fn text(n: &YmlMerge) -> Option<&str> {
    n.text.as_deref()
}

#[test]
fn iso_datetimes() {
    assert_eq!(iso_datetime(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso_datetime(1_793_786_400_123), "2026-11-04T10:00:00.123Z");
    assert_eq!(iso_datetime(951_782_400_000), "2000-02-29T00:00:00.000Z");
}

#[test]
fn one_side_changed() {
    assert_eq!(text(&m(Some("a: 1"), Some("a: 2"), Some("a: 1"))), Some("a: 2"));
    assert_eq!(text(&m(None, None, Some("new: 1"))), Some("new: 1"));
}

#[test]
fn both_changed_different_keys_merge() {
    let r = m(Some("a: 1\nb: 1\n"), Some("a: 2\nb: 1\n"), Some("a: 1\nb: 3\nc: 4\n"));
    assert!(r.conflicts.is_empty());
    let v = parse_yaml(text(&r).unwrap()).unwrap();
    assert_eq!(v, parse_yaml("a: 2\nb: 3\nc: 4\n").unwrap());
}

#[test]
fn a_conflict_keeps_the_same_side_on_every_device() {
    let r = m(Some("a: 1\nb: 1\n"), Some("a: 2\nb: 1\n"), Some("a: 3\nb: 5\n"));
    assert_eq!(parse_yaml(text(&r).unwrap()).unwrap(), parse_yaml("a: 3\nb: 5\n").unwrap());
    assert_eq!(r.conflicts.len(), 1);
    assert_eq!(r.conflicts[0].lost, Some(Value::from(2)));
}

#[test]
fn unparseable_is_a_whole_text_conflict() {
    let r = m(Some("a: 1"), Some("a: [x"), Some("a: 2"));
    assert!(r.raw);
    assert_eq!(text(&r), Some("a: [x"));
    assert_eq!(r.conflicts[0].lost, Some(Value::from("a: 2")));
}

const NOTE: &str = "id: k\ngestalt: note@1\n";

#[test]
fn text_fields_merge_by_line() {
    let n = |main: &str| format!("{NOTE}main: |\n  {main}\n");
    let r = m(Some(&n("one\n  two\n  three")), Some(&n("ONE\n  two\n  three")), Some(&n("one\n  two\n  THREE")));
    assert!(r.conflicts.is_empty());
    assert_eq!(parse_yaml(text(&r).unwrap()).unwrap()["main"], Value::from("ONE\ntwo\nTHREE\n"));
}

#[test]
fn lists_of_references_merge_as_sets() {
    let rel = |to: &[&str]| format!("{NOTE}relationships: [{}]\n", to.iter().map(|t| format!("{{to: {t}, label: see}}")).collect::<Vec<_>>().join(", "));
    let r = m(Some(&rel(&["a"])), Some(&rel(&["a", "b"])), Some(&rel(&["a", "c"])));
    assert!(r.conflicts.is_empty());
    assert_eq!(parse_yaml(text(&r).unwrap()).unwrap()["relationships"].as_sequence().unwrap().len(), 3);
    let tags = |t: &str| format!("{NOTE}tags: [{t}]\n");
    let r = m(Some(&tags("x, y")), Some(&tags("y")), Some(&tags("x, y, z")));
    let mut out: Vec<String> = parse_yaml(text(&r).unwrap()).unwrap()["tags"].as_sequence().unwrap().iter().map(|t| t.as_str().unwrap().to_owned()).collect();
    out.sort();
    assert_eq!(out, vec!["y", "z"]);
}

#[test]
fn only_the_named_gestalts_rules_apply() {
    // on another gestalt `main` would be a plain value; here it's text, because note@1 says so
    let g = Gestalts::from_yaml(&["name: other\nversion: 1\nfields: { main: { type: string } }\n"]).unwrap();
    let t = |v: &str| format!("id: k\ngestalt: other@1\nmain: {v}\n");
    assert_eq!(merge_yml("k", Some(&t("a")), Some(&t("b")), Some(&t("c")), &g, NOW).conflicts.len(), 1);
}

#[test]
fn sides_naming_different_gestalts_conflict_as_a_whole() {
    let a = "id: k\ngestalt: note@1\ntitle: a\n";
    let b = "id: k\ngestalt: other@1\ntitle: b\n";
    let r = m(Some("id: k\ngestalt: note@1\n"), Some(a), Some(b));
    assert!(r.raw);
    assert_eq!(r.conflicts.len(), 1);
}

#[test]
fn two_offline_reviews_keep_the_later_one() {
    let state = |at: &str, reps: u32, rating: u32| {
        format!("id: k\ngestalt: fsrs-data@1\ntarget: c\nmodel: FSRS-7\nlast_rating: {rating}\ncard: {{dueAt: '2026-02-01T00:00:00Z', lastReviewAt: '{at}', stability: 1, difficulty: 5, state: 2, reps: {reps}, lapses: 0}}\n")
    };
    let base = state("2026-01-01T00:00:00Z", 1, 3);
    let earlier = state("2026-01-02T00:00:00Z", 2, 1);
    let later = state("2026-01-03T00:00:00Z", 2, 4);
    let r = m(Some(&base), Some(&earlier), Some(&later));
    assert_eq!(text(&r), Some(later.as_str()));
    assert!(r.conflicts.is_empty());
    // rated on two devices before they ever synced: no base, and still no conflict
    let r = m(None, Some(&earlier), Some(&later));
    assert_eq!(text(&r), Some(later.as_str()));
    assert!(r.conflicts.is_empty());
}

#[test]
fn practice_sessions_union_their_events() {
    let base = "id: k\ngestalt: practice-session@1\napp: x\nstarted: '2026-01-01T00:00:00Z'\nactive_ms: 10\nevents:\n- {at: '2026-01-01T00:00:01Z'}\n";
    let l = "id: k\ngestalt: practice-session@1\napp: x\nstarted: '2026-01-01T00:00:00Z'\nactive_ms: 30\nevents:\n- {at: '2026-01-01T00:00:01Z'}\n- {at: '2026-01-01T00:00:03Z'}\n";
    let r = "id: k\ngestalt: practice-session@1\napp: x\nstarted: '2026-01-01T00:00:00Z'\nactive_ms: 20\nevents:\n- {at: '2026-01-01T00:00:01Z'}\n- {at: '2026-01-01T00:00:02Z'}\n";
    let out = m(Some(base), Some(l), Some(r));
    assert!(out.conflicts.is_empty());
    let v = parse_yaml(text(&out).unwrap()).unwrap();
    assert_eq!(v["active_ms"], Value::from(30));
    assert_eq!(v["events"].as_sequence().unwrap().len(), 3);
}

#[test]
fn tombstones() {
    let t = tombstone("k", "2026-01-01T00:00:00Z");
    assert!(is_tombstone_text(&t));
    assert!(!is_tombstone_text("id: k\ndeleted: 2026-01-01\ntitle: a note about deletion\n"));
    // a delete against an unchanged note deletes it
    assert_eq!(text(&m(Some("a: 1"), Some(&t), Some("a: 1"))), Some(t.as_str()));
    // against an edit too, and the edit is kept as a conflict
    let r = m(Some("a: 1"), Some(&t), Some("a: 2"));
    assert_eq!(text(&r), Some(t.as_str()));
    assert_eq!(r.conflicts[0].lost, Some(parse_yaml("a: 2").unwrap()));
    assert!(r.conflicts[0].path.is_empty());
    // writing over a tombstone brings the note back
    assert_eq!(text(&m(Some(&t), Some(&t), Some("a: 3"))), Some("a: 3"));
    // two deletes: the later
    let t2 = tombstone("k", "2026-02-01T00:00:00Z");
    assert_eq!(text(&m(Some("a: 1"), Some(&t), Some(&t2))), Some(t2.as_str()));
}

#[test]
fn a_file_removed_by_hand_is_a_delete() {
    let r = m(Some("id: k\na: 1\n"), None, Some("id: k\na: 1\n"));
    assert_eq!(text(&r), Some(tombstone("k", NOW).as_str()));
    // and loses nothing that was edited meanwhile
    let r = m(Some("id: k\na: 1\n"), None, Some("id: k\na: 2\n"));
    assert!(is_tombstone_text(text(&r).unwrap()));
    assert_eq!(r.conflicts.len(), 1);
}

#[test]
fn conflict_ymls_are_the_same_on_every_device() {
    let c = Conflict { path: vec![Segment::Key("a".into())], base: Some(1.into()), kept: Some(3.into()), lost: Some(2.into()) };
    let (k1, t1) = conflict_yml("n", &c, false, NOW);
    let (k2, _) = conflict_yml("n", &c, false, "2027-01-01T00:00:00Z");
    assert_eq!(k1, k2);
    let y = crate::yml::Yml::parse(&k1, &t1);
    assert_eq!(Gestalts::builtin().classify(&y), crate::gestalt::YmlState::Valid("conflict@1".into()));
    let other = Conflict { lost: Some(4.into()), ..c };
    assert_ne!(conflict_yml("n", &other, false, NOW).0, k1);
}
