# Concept modelling: grain, structure, navigation

Theoretical background from a design discussion on 2026-11-16. Concrete proposals are in
[[../roadmap/concept-model|Concept model roadmap]]. Starting point: `concept@2` is deliberately wide, which
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
