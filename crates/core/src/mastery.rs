//! What a learner knows, estimated from what happened: `practice-event`s (either version), the `concepts` and
//! `responses` of what they practised, and the `concept-link@1`s between concepts. Nothing here is stored: beliefs are worked out from the index, so a better
//! graph or model reinterprets all past practice. They are kept up to date as the index changes, and views only ever
//! get the beliefs they ask for ([`crate::repo::Repo::subscribe_beliefs`]), never the events.
//!
//! The model (v0, a heuristic): each concept has a belief about its mastery on the logit scale, a mean and a variance,
//! starting from the same prior. Events are replayed in time order:
//!
//! - An item's event predicts its outcome from its concepts' means, weighted by its `concepts`, and moves each concept
//!   by a one-step Laplace update of a logistic model (the update Glicko and online Bayesian Elo use): more for concepts
//!   it practises more, and for concepts the belief is less sure about. Each then grows surer.
//! - An event whose subject is a concept is the same with that concept alone at weight 1. A subject that is neither
//!   (deleted, or practising nothing) says nothing.
//! - An event naming a `response` (the mistake a picked option stands for) also practises that response's concepts,
//!   from the subject's `responses`, else its `model`'s. Where a concept is in both, the larger weight counts.
//! - A subject with a `chance` (its own, else its model's) can be right by guessing: the outcome is predicted as
//!   `c + (1 − c)·σ(η)` (the 3PL item response model's guessing floor), so a right answer says less about the concepts
//!   the likelier a guess was. Without one it is 0, the plain logistic model.
//! - Rating 0 ("came up, no score") counts as seen and moves nothing.
//! - A change on a concept spreads along its outgoing links, scaled by each link's weight and damped, for at most
//!   `hops` steps and never to a concept this event already reached, so cycles end. Linked concepts grow surer too, by
//!   the square of that scale. Several claims about one pair (from different sources) count as their mean.
//! - Unpractised, a belief grows less sure with time (forgetting), up to the prior.
//!
//! This stands in for a latent-skill model with correlated skills (a Gaussian graphical model over concepts, fitted to
//! all events at once). What's meant to last is the interface: events, item weights and links in, beliefs out.
//!
//! Keeping up: an event later than every one replayed so far is one more step. Anything else (an earlier event arriving
//! by sync, an event edited or deleted, a link or an item's `concepts` changing, a concept appearing) marks the
//! beliefs stale, and the next read replays everything. So does a change to what an item or item model says about
//! responses or guessing.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_yaml_ng::{Mapping, Value};

use crate::index::{Entry, Index};
use crate::merge::parse_iso_datetime;

/// What practice is logged as: every version, read alike (later ones only add optional props).
pub const EVENTS: [&str; 2] = ["practice-event@1", "practice-event@2"];
/// How concepts relate.
pub const LINK: &str = "concept-link@1";
/// A subject of this gestalt (any version) is a concept itself.
const CONCEPT: &str = "concept";
/// The prop through which a yml says what it practises: concept id to weight.
const CONCEPTS: &str = "concepts";
/// The prop naming kinds of answer, each with the `concepts` it is evidence about.
const RESPONSES: &str = "responses";
/// The prop saying how often a guess is right.
const CHANCE: &str = "chance";
/// The prop through which an item names the item model it was made by.
const MODEL: &str = "model";

const DAY_MS: f64 = 86_400_000.0;
const LIMIT: f64 = 6.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MasteryParams {
    pub prior_mean: f64,
    pub prior_sd: f64,
    /// variance a belief gains per day unpractised
    pub drift_per_day: f64,
    /// a link's weight is multiplied by this at each step
    pub damping: f64,
    pub hops: usize,
    /// a change smaller than this spreads no further
    pub min_change: f64,
}

impl Default for MasteryParams {
    fn default() -> Self {
        MasteryParams { prior_mean: 0.0, prior_sd: 1.5, drift_per_day: 0.01, damping: 0.8, hops: 2, min_change: 0.005 }
    }
}

/// What is believed about one concept.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Belief {
    pub concept: String,
    /// logit mastery: 0 is a coin flip
    pub mean: f64,
    pub sd: f64,
    /// the chance of getting something on it right, `σ(mean)`
    pub p: f64,
    /// events on it directly (an item practising it, or itself)
    pub evidence: u32,
    /// the last event that reached it, directly or by a link
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_at: Option<String>,
}

impl Belief {
    /// Whether `other` says something different, beyond forgetting with time.
    pub fn differs(&self, other: &Belief) -> bool {
        self.mean != other.mean || self.evidence != other.evidence || self.last_at != other.last_at
    }
}

fn sigmoid(x: f64) -> f64 {
    1.0 / (1.0 + (-x).exp())
}

fn outcome(rating: i64) -> Option<f64> {
    match rating {
        -2 => Some(0.0),
        -1 => Some(0.25),
        1 => Some(0.75),
        2 => Some(1.0),
        _ => None,
    }
}

#[derive(Debug, Clone)]
struct State {
    mean: f64,
    variance: f64,
    evidence: u32,
    /// unix ms it was last brought up to date at
    at: i64,
    last_at: Option<String>,
}

/// One event, ordered by time, then id.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Key(i64, String);

#[derive(Debug, Clone, PartialEq)]
struct Event {
    key: Key,
    at: String,
    subject: String,
    rating: i64,
    response: Option<String>,
}

fn event_of(e: &Entry) -> Option<Event> {
    if !EVENTS.contains(&e.gestalt()?) {
        return None;
    }
    let at = e.yml.get("at")?.as_str()?.to_owned();
    Some(Event {
        key: Key(parse_iso_datetime(&at)?, e.yml.id.clone()),
        at,
        subject: e.yml.get("subject")?.as_str()?.to_owned(),
        rating: e.yml.get("rating")?.as_i64()?,
        response: e.yml.get("response").and_then(Value::as_str).map(str::to_owned),
    })
}

fn link_of(e: &Entry) -> Option<(String, String, f64)> {
    if e.gestalt() != Some(LINK) {
        return None;
    }
    let s = |k: &str| e.yml.get(k).and_then(Value::as_str).map(str::to_owned);
    Some((s("from")?, s("to")?, e.yml.get("weight")?.as_f64()?))
}

fn is_concept(e: &Entry) -> bool {
    e.gestalt().and_then(|g| g.split('@').next()) == Some(CONCEPT)
}

/// A `{concept id: weight}` map, leaving out weights of 0.
fn weights_in(v: &Value) -> Option<BTreeMap<String, f64>> {
    let m: &Mapping = v.as_mapping()?;
    Some(m.iter().filter_map(|(k, w)| Some((k.as_str()?.to_owned(), w.as_f64()?))).filter(|(_, w)| *w > 0.0).collect())
}

/// What a yml practises, if it says: concept id to weight, leaving out weights of 0.
fn concepts_of(e: &Entry) -> Option<BTreeMap<String, f64>> {
    e.gestalt()?;
    weights_in(e.yml.get(CONCEPTS)?)
}

/// The kinds of answer a yml tells apart, if it says: each with the concepts it is evidence about.
fn responses_of(e: &Entry) -> Option<BTreeMap<String, BTreeMap<String, f64>>> {
    e.gestalt()?;
    let m: &Mapping = e.yml.get(RESPONSES)?.as_mapping()?;
    Some(m.iter().filter_map(|(k, r)| Some((k.as_str()?.to_owned(), r.get(CONCEPTS).and_then(weights_in).unwrap_or_default()))).collect())
}

/// How often a guess is right, if a yml says.
fn chance_of(e: &Entry) -> Option<f64> {
    e.gestalt()?;
    e.yml.get(CHANCE)?.as_f64()
}

/// The item model a yml was made by, if it names one.
fn model_of(e: &Entry) -> Option<String> {
    e.gestalt()?;
    e.yml.get(MODEL)?.as_str().map(str::to_owned)
}

/// Everything about a yml the beliefs depend on; two equal ones change nothing.
#[derive(Debug, PartialEq, Default)]
struct Inputs {
    event: Option<Event>,
    link: Option<(String, String, f64)>,
    concepts: Option<BTreeMap<String, f64>>,
    responses: Option<BTreeMap<String, BTreeMap<String, f64>>>,
    chance: Option<f64>,
    model: Option<String>,
    concept: bool,
}

impl Inputs {
    fn of(e: Option<&Entry>) -> Self {
        e.map_or_else(Inputs::default, |e| Inputs {
            event: event_of(e),
            link: link_of(e),
            concepts: concepts_of(e),
            responses: responses_of(e),
            chance: chance_of(e),
            model: model_of(e),
            concept: is_concept(e),
        })
    }

    /// Whether this says anything about how other ymls' events read.
    fn shapes_events(&self) -> bool {
        self.link.is_some() || self.concepts.is_some() || self.responses.is_some() || self.chance.is_some() || self.model.is_some() || self.concept
    }
}

pub struct Mastery {
    params: MasteryParams,
    states: BTreeMap<String, State>,
    /// the latest event replayed or waiting to be
    tail: Option<Key>,
    /// events later than all replayed ones, by id, not replayed yet
    pending: Vec<String>,
    stale: bool,
}

impl Default for Mastery {
    fn default() -> Self {
        Mastery::new(MasteryParams::default())
    }
}

impl Mastery {
    pub fn new(params: MasteryParams) -> Self {
        Mastery { params, states: BTreeMap::new(), tail: None, pending: Vec::new(), stale: true }
    }

    /// Takes in that `id` changed from `old` to `new`; whether that can change any belief.
    pub fn observe(&mut self, id: &str, old: Option<&Entry>, new: Option<&Entry>) -> bool {
        let (before, after) = (Inputs::of(old), Inputs::of(new));
        if before == after {
            return false;
        }
        let only_a_new_event = before == Inputs::default() && !after.shapes_events();
        match after.event {
            Some(e) if only_a_new_event && !self.stale && self.tail.as_ref().is_none_or(|t| e.key > *t) => {
                self.tail = Some(e.key);
                self.pending.push(id.to_owned());
            }
            _ => self.stale = true,
        }
        true
    }

    /// Replays what hasn't been: everything when stale, else the pending events.
    fn catch_up(&mut self, index: &Index) {
        if self.stale {
            let mut events: Vec<Event> = EVENTS.iter().flat_map(|g| index.of_gestalt(g)).filter_map(event_of).collect();
            events.sort_by(|a, b| a.key.cmp(&b.key));
            self.states.clear();
            self.pending.clear();
            self.tail = events.last().map(|e| e.key.clone());
            let links = links(index);
            for e in &events {
                self.apply(e, index, &links);
            }
            self.stale = false;
        } else if !self.pending.is_empty() {
            let mut events: Vec<Event> = self.pending.drain(..).filter_map(|id| index.get(&id).and_then(event_of)).collect();
            events.sort_by(|a, b| a.key.cmp(&b.key));
            let links = links(index);
            for e in &events {
                self.apply(e, index, &links);
            }
        }
    }

    /// `id` brought to `t`: created at the prior, and less sure for the time since it was last reached.
    fn state(&mut self, id: &str, t: i64) -> &mut State {
        let cfg = self.params;
        let prior_var = cfg.prior_sd * cfg.prior_sd;
        let s = self.states.entry(id.to_owned()).or_insert(State { mean: cfg.prior_mean, variance: prior_var, evidence: 0, at: t, last_at: None });
        if t > s.at {
            s.variance = (s.variance + cfg.drift_per_day * ((t - s.at) as f64 / DAY_MS)).min(prior_var);
            s.at = t;
        }
        s
    }

    fn apply(&mut self, e: &Event, index: &Index, links: &BTreeMap<String, Vec<(String, f64)>>) {
        let t = e.key.0;
        let subject = index.get(&e.subject);
        let model = subject.and_then(model_of).and_then(|m| index.get(&m));
        let (weights, chance): (Vec<(String, f64)>, f64) = match subject {
            Some(s) if is_concept(s) => (vec![(e.subject.clone(), 1.0)], 0.0),
            Some(s) => {
                let mut weights = concepts_of(s).unwrap_or_default();
                // what the answer given is evidence about, beyond what the item practises
                let response = e.response.as_ref().and_then(|r| {
                    let of = |y: &Entry| responses_of(y).and_then(|mut rs| rs.remove(r));
                    of(s).or_else(|| model.and_then(of))
                });
                for (c, w) in response.into_iter().flatten() {
                    let v = weights.entry(c).or_insert(0.0);
                    *v = v.max(w);
                }
                (weights.into_iter().collect(), chance_of(s).or_else(|| model.and_then(chance_of)).unwrap_or(0.0))
            }
            None => (vec![], 0.0),
        };
        if weights.is_empty() {
            return;
        }
        for (id, _) in &weights {
            let s = self.state(id, t);
            s.evidence += 1;
            s.last_at = Some(e.at.clone());
        }
        let Some(y) = outcome(e.rating) else { return };
        let total: f64 = weights.iter().map(|(_, w)| w).sum();
        let s = sigmoid(weights.iter().map(|(id, w)| w * self.states[id].mean).sum::<f64>() / total);
        // the prediction with a guessing floor: p = c + (1 − c)·s, its slope in the logit d, and what follows for the
        // log likelihood's gradient (y − p)·d/(p(1 − p)) and information d²/(p(1 − p)); both are the plain logistic
        // ones, exactly, when c is 0
        let c = chance.clamp(0.0, 1.0);
        let p = c + (1.0 - c) * s;
        let d = (1.0 - c) * s * (1.0 - s);
        let q = p * (1.0 - p);
        if q <= 0.0 || d <= 0.0 {
            return;
        }
        let r = d / q;
        let gradient = (y - p) * r;
        let info = d * r;
        // every concept is updated against the same prediction, then the changes spread
        let changes: Vec<(String, f64, f64)> = weights
            .iter()
            .map(|(id, w)| {
                let s = &self.states[id];
                let variance = 1.0 / (1.0 / s.variance + w * w * info);
                (id.clone(), *w, variance * w * gradient)
            })
            .collect();
        let mut reached: BTreeSet<String> = weights.iter().map(|(id, _)| id.clone()).collect();
        for (id, w, change) in &changes {
            let s = self.states.get_mut(id).expect("brought up above");
            s.variance = 1.0 / (1.0 / s.variance + w * w * info);
            s.mean = (s.mean + change).clamp(-LIMIT, LIMIT);
        }
        let cfg = self.params;
        for (id, w, change) in changes {
            let mut frontier = vec![(id, change, w)];
            for _ in 0..cfg.hops {
                let mut next = Vec::new();
                for (from, change, scale) in frontier {
                    for (to, weight) in links.get(&from).into_iter().flatten() {
                        let k = weight * cfg.damping;
                        let c = change * k;
                        if reached.contains(to) || c.abs() < cfg.min_change {
                            continue;
                        }
                        reached.insert(to.clone());
                        let scale = scale * k;
                        let s = self.state(to, t);
                        s.variance = 1.0 / (1.0 / s.variance + scale * scale * info);
                        s.mean = (s.mean + c).clamp(-LIMIT, LIMIT);
                        s.last_at = Some(e.at.clone());
                        next.push((to.clone(), c, scale));
                    }
                }
                if next.is_empty() {
                    break;
                }
                frontier = next;
            }
        }
    }

    /// The beliefs about `concepts` as of `now_ms`, in that order: at the prior for one nothing reached.
    pub fn beliefs(&mut self, index: &Index, concepts: &[String], now_ms: i64) -> Vec<Belief> {
        self.catch_up(index);
        let cfg = self.params;
        let prior_var = cfg.prior_sd * cfg.prior_sd;
        concepts
            .iter()
            .map(|c| match self.states.get(c) {
                None => Belief { concept: c.clone(), mean: cfg.prior_mean, sd: cfg.prior_sd, p: sigmoid(cfg.prior_mean), evidence: 0, last_at: None },
                Some(s) => {
                    let variance = match now_ms.cmp(&s.at) {
                        Ordering::Greater => (s.variance + cfg.drift_per_day * ((now_ms - s.at) as f64 / DAY_MS)).min(prior_var),
                        _ => s.variance,
                    };
                    Belief { concept: c.clone(), mean: s.mean, sd: variance.sqrt(), p: sigmoid(s.mean), evidence: s.evidence, last_at: s.last_at.clone() }
                }
            })
            .collect()
    }
}

/// Outgoing links by concept, leaving out self-links. Several claims about one pair (from different sources) count as
/// their mean.
fn links(index: &Index) -> BTreeMap<String, Vec<(String, f64)>> {
    let mut claims: BTreeMap<(String, String), Vec<f64>> = BTreeMap::new();
    for (from, to, weight) in index.of_gestalt(LINK).filter_map(link_of) {
        if from != to {
            claims.entry((from, to)).or_default().push(weight);
        }
    }
    let mut out: BTreeMap<String, Vec<(String, f64)>> = BTreeMap::new();
    for ((from, to), weights) in claims {
        let weight = weights.iter().sum::<f64>() / weights.len() as f64;
        if weight > 0.0 {
            out.entry(from).or_default().push((to, weight));
        }
    }
    out
}

#[cfg(test)]
mod tests;
