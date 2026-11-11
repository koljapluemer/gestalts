use super::*;
use crate::gestalt::Gestalts;
use crate::merge::iso_datetime;
use crate::yml::Yml;

/// 2026-11-11T12:00:00Z
const NOW: i64 = 1_794_398_400_000;
const MIN: i64 = 60_000;

/// An index and the estimator kept up with it, as the repo does.
struct World {
    index: Index,
    mastery: Mastery,
    gestalts: Gestalts,
    events: usize,
}

impl World {
    fn new() -> Self {
        World { index: Index::default(), mastery: Mastery::default(), gestalts: Gestalts::builtin(), events: 0 }
    }

    fn put(&mut self, id: &str, raw: &str) {
        let old = self.index.insert(Entry::new(Yml::parse(id, format!("id: {id}\n{raw}")), &self.gestalts));
        let new = self.index.get(id).cloned();
        self.mastery.observe(id, old.as_ref(), new.as_ref());
    }

    fn remove(&mut self, id: &str) {
        let old = self.index.remove(id);
        self.mastery.observe(id, old.as_ref(), None);
    }

    fn concept(&mut self, id: &str) -> &mut Self {
        self.put(id, &format!("gestalt: concept@2\nname: {id}\n"));
        self
    }

    fn card(&mut self, id: &str, concepts: &[(&str, f64)]) -> &mut Self {
        let map: String = concepts.iter().map(|(c, w)| format!("{c}: {w}, ")).collect();
        self.put(id, &format!("gestalt: flashcard@1\nfront: q\nconcepts: {{{map}}}\n"));
        self
    }

    fn link(&mut self, from: &str, to: &str, weight: f64) -> &mut Self {
        self.put(&format!("l-{from}-{to}"), &format!("gestalt: concept-link@1\nfrom: {from}\nto: {to}\nweight: {weight}\n"));
        self
    }

    /// An event `minutes` after the first.
    fn event(&mut self, subject: &str, rating: i64, minutes: i64) -> &mut Self {
        self.events += 1;
        let at = iso_datetime(NOW - 1000 * MIN + minutes * MIN);
        self.put(&format!("e{}", self.events), &format!("gestalt: practice-event@1\nsubject: {subject}\nview: t\nat: {at}\nrating: {rating}\n"));
        self
    }

    fn at(&mut self, concept: &str, now: i64) -> Belief {
        self.mastery.beliefs(&self.index, &[concept.to_owned()], now).remove(0)
    }

    fn get(&mut self, concept: &str) -> Belief {
        self.at(concept, NOW)
    }

    /// The same, replayed from scratch.
    fn fresh(&mut self, concept: &str) -> Belief {
        Mastery::default().beliefs(&self.index, &[concept.to_owned()], NOW).remove(0)
    }
}

const PRIOR_SD: f64 = 1.5;

#[test]
fn a_concept_nothing_reached_is_at_the_prior() {
    let b = World::new().get("x");
    assert_eq!((b.mean, b.sd, b.p, b.evidence, b.last_at), (0.0, PRIOR_SD, 0.5, 0, None));
}

#[test]
fn moves_with_the_rating_further_for_better_or_worse_and_grows_surer() {
    let mean = |r| World::new().card("f", &[("c", 1.0)]).event("f", r, 0).get("c").mean;
    assert!(mean(-2) < mean(-1) && mean(-1) < 0.0 && 0.0 < mean(1) && mean(1) < mean(2));
    assert!(World::new().card("f", &[("c", 1.0)]).event("f", 1, 0).get("c").sd < PRIOR_SD);
}

#[test]
fn moves_a_concept_less_the_less_an_item_practises_it() {
    let mut w = World::new();
    w.card("f", &[("strong", 1.0), ("weak", 0.2)]).event("f", 2, 0);
    let (strong, weak) = (w.get("strong").mean, w.get("weak").mean);
    assert!(strong > weak && weak > 0.0);
}

#[test]
fn a_rating_of_0_is_seen_and_moves_nothing() {
    let b = World::new().concept("word").event("word", 0, 0).get("word");
    assert_eq!((b.mean, b.evidence), (0.0, 1));
}

#[test]
fn a_concept_may_be_the_subject_and_anything_else_says_nothing() {
    assert!(World::new().concept("word").event("word", 2, 0).get("word").mean > 0.0);
    // practising nothing, and nothing at all
    let mut w = World::new();
    w.put("n", "gestalt: note@1\n");
    w.event("n", 2, 0).event("gone", 2, 1);
    assert_eq!(w.get("n").evidence, 0);
    assert_eq!(w.get("gone").evidence, 0);
}

#[test]
fn spreads_along_links_one_way_and_less_than_on_the_concept() {
    let mut w = World::new();
    w.card("f", &[("produce", 1.0)]).link("produce", "recognise", 0.9).event("f", 2, 0);
    let (produce, recognise) = (w.get("produce"), w.get("recognise"));
    assert!(recognise.mean > 0.0 && recognise.mean < produce.mean);
    assert_eq!(recognise.evidence, 0);
    assert!(recognise.last_at.is_some());
    let mut back = World::new();
    back.card("f", &[("recognise", 1.0)]).link("produce", "recognise", 0.9).event("f", 2, 0);
    assert_eq!(back.get("produce").mean, 0.0);
}

#[test]
fn ends_on_cycles_and_stays_bounded() {
    let mut w = World::new();
    w.concept("a").link("a", "b", 1.0).link("b", "a", 1.0).link("b", "c", 1.0).link("c", "a", 1.0);
    for i in 0..200 {
        w.event("a", 2, i);
    }
    for c in ["a", "b", "c"] {
        assert!(w.get(c).mean.abs() <= LIMIT);
    }
    assert!(w.get("b").mean < w.get("a").mean);
}

#[test]
fn stops_after_the_hop_limit() {
    let mut w = World::new();
    w.concept("a").link("a", "b", 1.0).link("b", "c", 1.0).link("c", "d", 1.0).event("a", 2, 0);
    assert!(w.get("c").mean > 0.0);
    assert_eq!(w.get("d").mean, 0.0);
}

#[test]
fn claims_about_one_pair_count_as_their_mean() {
    let mut one = World::new();
    one.concept("a").link("a", "b", 0.5).event("a", 2, 0);
    let mut two = World::new();
    two.concept("a");
    two.put("l1", "gestalt: concept-link@1\nfrom: a\nto: b\nweight: 0.2\nsource: x\n");
    two.put("l2", "gestalt: concept-link@1\nfrom: a\nto: b\nweight: 0.8\nsource: y\n");
    two.event("a", 2, 0);
    assert!((one.get("b").mean - two.get("b").mean).abs() < 1e-12);
}

#[test]
fn grows_less_sure_with_time_up_to_the_prior() {
    let mut w = World::new();
    w.concept("c").event("c", 2, 0);
    let soon = w.at("c", NOW).sd;
    let later = w.at("c", NOW + 30 * 86_400_000).sd;
    let much = w.at("c", NOW + 10_000 * 86_400_000).sd;
    assert!(later > soon);
    assert!((much - PRIOR_SD).abs() < 1e-9);
}

#[test]
fn new_events_in_order_are_steps_and_land_where_a_replay_does() {
    let mut w = World::new();
    w.card("f", &[("x", 1.0), ("y", 0.5)]).link("x", "z", 0.6);
    w.get("x");
    for (i, r) in [2, -1, 1, 2, -2].into_iter().enumerate() {
        w.event("f", r, i as i64);
        assert!(!w.mastery.stale, "an event in order is a step");
        for c in ["x", "y", "z"] {
            assert_eq!(w.get(c), w.fresh(c));
        }
    }
}

#[test]
fn whatever_else_changes_is_replayed_and_reinterprets_the_past() {
    let mut w = World::new();
    w.card("f", &[("x", 1.0)]).event("f", 2, 10).event("f", 1, 20);
    let before = w.get("y");
    assert_eq!(before.mean, 0.0);

    // a new link reads all past practice anew
    w.link("x", "y", 0.5);
    assert!(w.mastery.stale);
    assert!(w.get("y").mean > 0.0);
    assert_eq!(w.get("y"), w.fresh("y"));

    // an earlier event, from a sync
    w.event("f", -2, 0);
    assert!(w.mastery.stale);
    assert_eq!(w.get("x"), w.fresh("x"));

    // the card practising something else
    w.card("f", &[("x", 0.5), ("q", 1.0)]);
    assert_eq!(w.get("q"), w.fresh("q"));
    assert!(w.get("q").evidence == 3);

    // an event gone
    w.remove("e1");
    assert_eq!(w.get("x"), w.fresh("x"));
    assert_eq!(w.get("q").evidence, 2);
}

#[test]
fn what_beliefs_dont_depend_on_changes_nothing() {
    let mut w = World::new();
    w.card("f", &[("x", 1.0)]).event("f", 2, 0);
    w.get("x");
    w.put("f", "gestalt: flashcard@1\nfront: edited\nconcepts: {x: 1.0, }\n");
    w.put("n", "gestalt: note@1\nmain: hi\n");
    assert!(!w.mastery.stale);
    assert!(w.mastery.pending.is_empty());
}

#[test]
#[ignore = "a measurement, not a check: cargo test --release -p gestalts-core replay_cost -- --ignored --nocapture"]
fn replay_cost() {
    let mut w = World::new();
    for c in 0..2000 {
        w.card(&format!("f{c}"), &[(&format!("c{c}"), 1.0), (&format!("c{}", c % 50), 0.4), (&format!("c{}", c % 7), 0.2)]);
        w.link(&format!("c{c}"), &format!("c{}", (c * 7) % 2000), 0.5);
    }
    for i in 0..50_000 {
        w.event(&format!("f{}", (i * 31) % 2000), [2, 1, -1, -2][i as usize % 4], i);
    }
    let t = std::time::Instant::now();
    w.fresh("c1");
    eprintln!("full replay of 50k events over 2k cards and links: {:?}", t.elapsed());
}
