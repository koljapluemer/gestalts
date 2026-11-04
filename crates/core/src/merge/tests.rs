use super::*;
use crate::storage::Memory;

const NOW: &str = "2026-11-04T10:00:00Z";

fn m(b: Option<&str>, l: Option<&str>, r: Option<&str>) -> NoteMerge {
    let g = Gestalts::builtin();
    let x = merge_note("k", b, l, r, &g, NOW);
    // symmetric, whichever side is local
    assert_eq!(x, merge_note("k", b, r, l, &g, NOW), "not symmetric");
    x
}

fn text(n: &NoteMerge) -> Option<&str> {
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

#[test]
fn text_fields_merge_by_line() {
    let r = m(Some("main: |\n  one\n  two\n  three\n"), Some("main: |\n  ONE\n  two\n  three\n"), Some("main: |\n  one\n  two\n  THREE\n"));
    assert!(r.conflicts.is_empty());
    assert_eq!(parse_yaml(text(&r).unwrap()).unwrap()["main"], Value::from("ONE\ntwo\nTHREE\n"));
}

#[test]
fn set_keys_merge_as_sets() {
    let r = m(Some("relationships: [a]\n"), Some("relationships: [a, b]\n"), Some("relationships: [a, c]\n"));
    assert!(r.conflicts.is_empty());
    let rels = parse_yaml(text(&r).unwrap()).unwrap()["relationships"].clone();
    assert_eq!(rels.as_sequence().unwrap().len(), 3);
    let r = m(Some("tags: [x, y]\n"), Some("tags: [y]\n"), Some("tags: [x, y, z]\n"));
    let mut tags: Vec<String> = parse_yaml(text(&r).unwrap()).unwrap()["tags"].as_sequence().unwrap().iter().map(|t| t.as_str().unwrap().to_owned()).collect();
    tags.sort();
    assert_eq!(tags, vec!["y", "z"]);
}

#[test]
fn two_offline_reviews_keep_the_later_one() {
    let state = |at: &str, reps: u32, rating: u32| {
        format!("tags: [fsrs-state]\nrelationships: [{{to: c, label: reviews}}]\nmodel: FSRS-7\nlast_rating: {rating}\ncard: {{dueAt: '2026-02-01T00:00:00Z', lastReviewAt: '{at}', stability: 1, difficulty: 5, state: 2, reps: {reps}, lapses: 0}}\n")
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
    let base = "tags: [practice-session]\napp: x\nstarted: '2026-01-01T00:00:00Z'\nactive_ms: 10\nevents:\n- {at: '2026-01-01T00:00:01Z'}\n";
    let l = "tags: [practice-session]\napp: x\nstarted: '2026-01-01T00:00:00Z'\nactive_ms: 30\nevents:\n- {at: '2026-01-01T00:00:01Z'}\n- {at: '2026-01-01T00:00:03Z'}\n";
    let r = "tags: [practice-session]\napp: x\nstarted: '2026-01-01T00:00:00Z'\nactive_ms: 20\nevents:\n- {at: '2026-01-01T00:00:01Z'}\n- {at: '2026-01-01T00:00:02Z'}\n";
    let out = m(Some(base), Some(l), Some(r));
    assert!(out.conflicts.is_empty());
    let v = parse_yaml(text(&out).unwrap()).unwrap();
    assert_eq!(v["active_ms"], Value::from(30));
    assert_eq!(v["events"].as_sequence().unwrap().len(), 3);
}

#[test]
fn cards_merge_per_card() {
    let base = "cards:\n- {id: a, front: x, back: y}\n";
    let l = "cards:\n- {id: a, front: X, back: y}\n";
    let r = "cards:\n- {id: a, front: x, back: y}\n- {id: b, front: n, back: m}\n";
    let out = m(Some(base), Some(l), Some(r));
    assert!(out.conflicts.is_empty());
    assert_eq!(parse_yaml(text(&out).unwrap()).unwrap(), parse_yaml("cards:\n- {id: a, front: X, back: y}\n- {id: b, front: n, back: m}\n").unwrap());
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
fn gestalt_policies_combine() {
    let g = Gestalts::from_yaml(&[
        "name: a\nversion: 1\nrequires_tags: [a]\nmerge: { keys: { n: max } }\n",
        "name: b\nversion: 1\nrequires_tags: [b]\nmerge: { keys: { n: min, o: max } }\n",
    ])
    .unwrap();
    let note = Note::parse("k", "tags: [a, b]\n");
    let p = note_policy(&g, &[&note]);
    let Policy::Map(keys) = p else { panic!() };
    assert_eq!(keys["n"], Policy::Conflict);
    assert_eq!(keys["o"], Policy::Max);
    assert_eq!(keys["tags"], Policy::Set);
    assert!(Gestalts::from_yaml(&["name: a\nversion: 1\nmerge: sometimes\n"]).is_err());
}

#[test]
fn conflict_notes_are_the_same_on_every_device() {
    let c = Conflict { path: vec![Segment::Key("a".into())], base: Some(1.into()), kept: Some(3.into()), lost: Some(2.into()) };
    let (k1, t1) = conflict_note("n", "n", &c, false, NOW);
    let (k2, _) = conflict_note("n", "n", &c, false, "2027-01-01T00:00:00Z");
    assert_eq!(k1, k2);
    let g = Gestalts::builtin();
    assert_eq!(g.of(&Note::parse(&k1, &t1)), vec!["conflict@1"], "{:?}", g.lint(&Note::parse(&k1, &t1)));
    let other = Conflict { lost: Some(4.into()), ..c };
    assert_ne!(conflict_note("n", "n", &other, false, NOW).0, k1);
}

#[test]
fn sync_converges() {
    pollster::block_on(async {
        let g = Gestalts::builtin();
        let (l, r, b) = (Memory::default(), Memory::default(), Memory::default());
        l.write_note("only-local", "x: 1").await.unwrap();
        r.write_note("only-remote", "y: 1").await.unwrap();
        r.write_note("uses-img", "blobs: [img.webp]").await.unwrap();
        r.write_blob("img.webp", b"123").await.unwrap();
        r.write_blob("unused.webp", b"9").await.unwrap();
        let rep = sync(&l, &r, &b, &g, NOW).await.unwrap();
        assert_eq!(rep.pulled, vec!["only-remote", "uses-img"]);
        assert_eq!(rep.pushed, vec!["only-local"]);
        assert_eq!(rep.blobs_pulled, vec!["img.webp"]);

        // both edit the same note, different keys; one deletes another
        l.write_note("only-local", "x: 2\nz: 1").await.unwrap();
        r.write_note("only-local", "x: 1\nw: 1").await.unwrap();
        r.write_note("only-remote", &tombstone("only-remote", NOW)).await.unwrap();
        let rep = sync(&l, &r, &b, &g, NOW).await.unwrap();
        assert!(rep.conflicts.is_empty());
        let merged = l.read_note("only-local").await.unwrap().unwrap();
        assert_eq!(r.read_note("only-local").await.unwrap().unwrap(), merged);
        assert!(is_tombstone_text(&l.read_note("only-remote").await.unwrap().unwrap()));

        // a real conflict: the same winner on both sides, and one conflict note
        l.write_note("only-local", "x: 3").await.unwrap();
        r.write_note("only-local", "x: 4").await.unwrap();
        let rep = sync(&l, &r, &b, &g, NOW).await.unwrap();
        assert_eq!(rep.conflicts.len(), 1);
        assert_eq!(l.read_note("only-local").await.unwrap().as_deref(), Some("x: 4"));
        assert_eq!(r.read_note("only-local").await.unwrap().as_deref(), Some("x: 4"));
        let ck = &rep.conflicts[0];
        let c = parse_yaml(&r.read_note(ck).await.unwrap().unwrap()).unwrap();
        assert_eq!(c["lost"], Value::from(3));
        assert_eq!(c["path"], parse_yaml("[x]").unwrap());
        assert_eq!(c["note"], Value::from("only-local"));

        // nothing changed: a no-op, and the conflict isn't recorded twice
        let rep = sync(&l, &r, &b, &g, NOW).await.unwrap();
        assert!(rep.pulled.is_empty() && rep.pushed.is_empty() && rep.conflicts.is_empty());
    });
}
