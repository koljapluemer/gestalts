# Concept modelling: grain, structure, navigation

Summary of a design discussion (2026-11-16), not yet decided. Starting point: `concept@2` is deliberately wide, which
works well for exercises tagged with a few abstractions (vizint, math-drills) but stretches with inventory apps
(alphabet-pronunciation-trainer, transparent-input: a concept per letter or flemma). Two symptoms: no sensible "recently
learned" graph, and nothing above the leaves ("this is language practice", "this is 8th grade math"). A top-down topic
ontology is ruled out from the start.

## The distinctions this rests on

- **Inventory vs. abstraction.** Inventory members (letters, flemmas, countries, flags) form countable sets and are
  learned one by one; abstractions (rounding, tones, integration) are learned by generalising. KLI calls these facts
  (constant condition, constant response) vs. rules/skills (variable), and claims they're learned by different mechanisms.
- **Counting vs. inference.** A set's state is an aggregate of its members (19 of 24 letters). An abstraction's state is
  inferred from evidence. Today `concept-link` does both, so member→set weights (alphabet's 0.3 / 0.1) mean nothing.
- **Player vs. content.** A plugin plays content and a deck is content. Listing and search should show entry points
  (plugin + deck, later + restriction), never plugins. Narrow views (a DNA replication trainer) are one entry point and
  wide ones (math-drills) are many.
- **Facts vs. generators.** Deck members are listed items (facts) or `item-model`s (generators). `practice-event@2`
  already handles both (`subject` may be an item model, plus `instance` and `response`).
- **Navigation vs. knowledge.** "Where are the views for X" belongs to each site. "How much X do I know" belongs to the
  user and must not depend on the site.

## Who holds what

| Owner | Writes | Lives in |
|---|---|---|
| deck / plugin author | concepts, items with `concepts`, evidence links, set concepts + memberships | `plugins/*/decks/` |
| distribution curator | table of contents: subjects → topics → a few concept refs | the distribution, e.g. `apps/loops-for-learning/` |
| user (by practising) | practice events, fsrs-data, concepts created at runtime | the user's repository |
| anyone | extra `concept-link` claims, signed via `source` | wherever they're made |

Derived in the core, never written: topic → entry points, deck → concepts, set → member counts, per-concept estimates,
the "unfiled" list.

## Roadmap

- **Every inventory plugin defines its set concept.** Greek alphabet, Vietnamese vocabulary, world countries, world
  flags. Alphabet already has `grc:alphabet`. transparent-input, world-map and flags-practice have none; their members
  are orphans.
- **Membership field `in: ref concept` on `concept`** (single-valued; frequency bands etc. stay links). It means "count
  me into this set" and replaces member→set `part-of` links. Views may rely on it, unlike `concept-link.kind`.
- **Set state derived in the core:** closed sets show *k of n*, open sets only *k known* (optionally frequency-weighted).
  A set concept's own evidence (items practising "the alphabet" directly) stays a separate signal from the count.
- **Optional `concepts` ref_map on `deck`**, for content that isn't made of items (simulations, interactive trainers).
  An entry point's concepts = the deck's own plus its items'. Every view ships at least one deck, so narrow views are
  ordinary entry points.
- **Document that deck members may be generators**, and that choosing what to schedule (item trace vs. concept state) is
  the view's job.

## Serious consideration

- **Table of contents per distribution**, as a small separate shape (`topic`: `name`, `parent`, `concepts: [refs]`),
  strictly a tree, closed world (covers only what the site has), no claim to be true elsewhere. Topic → entry points is
  derived (topic concepts → their members/descendants → items → decks). Concepts that are practised but filed under no
  topic go on an "unfiled" list for the curator. A simpler first step: topics listing deck ids directly in
  `distribution.yml`.
- **`closed` marker on set concepts** (name open), because the core can't tell "deck ships all members" from "members
  are whatever you've met".
- **One concept-level estimate fed by both fact and skill evidence**, with FSRS kept as the item scheduler. Without
  it, cross-view features compare a recall probability with a mastery estimate on different scales. This is the
  "Bayesian model, not yet implemented" from [generic-learning.md](generic-learning.md), and the next thing any
  procedural view runs into.
- **Aggregate by set and abstraction, never by raw concept touched.** Otherwise activity views are dominated by fact
  apps (50 reviews = 50 concepts touched, 50 multiplication problems = 3).
- **A rule for when a fact gets its own concept:** when several items share it (recognise vs. produce, world-map's
  France + flags' France). Otherwise the item alone may be enough. Matters most for transparent-input.
- **Curricula and levels as sourced schemes** ("lehrplan-by: Mathe 8", CEFR A2): concepts from that scheme linked to
  topics, several schemes side by side. Never a property of a concept.

## Optional, later

- **Restrictions on entry points** (plugin, deck, parameters): "world-map, only Africa", "multiplication, only the
  17s". One mechanism for search entry points and user practice configs; the plugin declares what it accepts and which
  concepts each value covers. Build it when a real view needs it.
- **Search from everyday language** ("want to learn about Africa"): query → concepts (names, aliases, ToC, embeddings or
  LLM) → entry points ranked by concept overlap. A layer on top, swappable, not part of the data model.
- **Emergent clustering** from co-practice data with LLM-named clusters, as an exploration lens only.
- **Aggregates honest about kinds:** views that count should say what they count, and treat missing `responses` on fact
  items as "no diagnosis", not "no misconceptions".

## Not worth considering

- **A global, top-down topic ontology.** It explodes, like every attempt before it.
- **A grain field on concept** (`item | skill | domain`). Arbitrary levels, and every author draws the lines differently:
  the same ontology problem, made smaller.
- **A separate gestalt for sets.** Sets are concepts that have members; a second shape would split the ToC, evidence
  links and graphs over two target types.
- **Automatic rollup above sets** ("Greek: 43%"). Not a sum of parts. Show sets side by side, or write an explicit,
  sourced concept with evidence links.
- **Percentages on open sets.** *n* is your exposure, not the language.
- **Building the ToC out of concepts + `part-of` links in the evidence graph.** It would claim "knowing rounding says
  0.x about math" and mix navigation into knowledge modelling.
- **Relying on `concept-link.kind` for structure.** It's documented as a hint.
- **Plugins as the unit to list or search.** Wrong grain for both wide and narrow views.
- **Fact vs. procedure as a property of a deck.** The boundary depends on the learner (10–20 multiplication can be
  memorised or computed). Decide where evidence goes per view, not per deck.
- **Stored structure from emergent clustering.** Labels and memberships shift between runs.

## Reading

- Koedinger, Corbett & Perfetti (2012), *The Knowledge-Learning-Instruction Framework*, Cognitive Science 36(5):
  fact vs. skill components, learned differently.
- Papoušek, Pelánek & Stanislav (2014), *Adaptive Practice of Facts in Domains with Varied Prior Knowledge*, EDM:
  adaptive geography practice.
- Tatsuoka (1983), rule space / Q-matrix: items × skills.
- Doignon & Falmagne (1999), *Knowledge Spaces*, and competence-based extensions.
- Rosch (1978), *Principles of Categorization*: basic-level categories, i.e. which grain to show.
- Shirky (2005), *Ontology is Overrated: Categories, Links, and Tags*.
- Bowker & Star (1999), *Sorting Things Out*.
- W3C SKOS Primer (2009): many concept schemes, mappings across them.
- Nation, *Learning Vocabulary in Another Language*: vocabulary as an inventory in frequency bands. SLA's "item vs.
  system learning" (source unverified).
