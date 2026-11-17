# Concept model roadmap

Proposals from the 2026-11-16 design discussion. They are not implemented or decided. See
[[../research/concept-modelling|Concept modelling]] for the distinctions and literature behind them, and
[[../reference/data-format#Concepts, practice and what a learner knows|Data format]] for the current model.

## Ownership

| Owner | Writes | Lives in |
|---|---|---|
| deck / plugin author | concepts, items with `concepts`, evidence links, set concepts and memberships | `plugins/*/decks/` |
| distribution curator | table of contents: subjects → topics → a few concept refs | the distribution |
| user, by practising | practice events, FSRS data, concepts created at runtime | the user's repository |
| anyone | extra `concept-link` claims, signed via `source` | wherever they are made |

The core would derive topic → entry points, deck → concepts, set → member counts, per-concept estimates, and the
unfiled list rather than storing them.

## Candidate changes

- Every inventory plugin defines its set concept. Alphabet already has `grc:alphabet`; transparent-input, world-map,
  and flags-practice do not yet have equivalents.
- Add a single-valued `in: ref concept` membership field to `concept`. Frequency bands and other evidence remain
  links. This replaces member → set `part-of` links.
- Derive set state in the core: closed sets show *k of n*; open sets show only *k known*. Direct evidence for the set
  remains separate from the member count.
- Optionally add a `concepts` ref map to `deck` for content not made of items. An entry point's concepts are the deck's
  own plus its items'.
- Document that deck members may be generators and leave scheduling item traces versus concept state to the view.

## Needs design

- A per-distribution table of contents, strictly a closed-world navigation tree. A simpler first version could list
  deck ids directly in `distribution.yml`.
- A `closed` marker on set concepts, because the core cannot infer whether a deck ships every member.
- One concept-level estimate fed by fact and skill evidence, with FSRS remaining the item scheduler. This continues
  the Bayesian direction in [[../research/generic-learning-original-brief|the original generic-learning brief]].
- Aggregate activity by set and abstraction rather than every raw concept touched.
- Give a fact its own concept when multiple items share it; otherwise the item may be sufficient.
- Represent curricula and levels as sourced schemes, never as an intrinsic property of a concept.

## Later

- Entry-point restrictions such as “world-map, only Africa,” shared by search and practice configuration.
- Everyday-language search mapped to concepts and then ranked entry points.
- Emergent clustering as an exploration lens, without storing it as canonical structure.
- Honest aggregate labels and explicit treatment of missing response diagnoses.
