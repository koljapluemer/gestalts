# Concept model roadmap

Proposals from the 2026-11-16 design discussion. The candidate changes are built (2026-11-17), except a `closed`
marker; the rest is not implemented or decided. See
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

## Built (2026-11-17)

- `concept@3`: a single-valued `in: ref concept`, written only for a member of a set (others stay `concept@2`). It
  replaced the member → set `part-of` links: Greek letters `in` `grc:alphabet` (words in no set), phrasebook concepts
  `in` `lang: vie` / `lang: ita`, Vietnamese words `in` `lang: vie` and marks `in` `vie: script`, countries `in`
  `geography: countries`, flags `in` `flag: country flags`, and transparent-input's flemmas `in` `lang: <code>`.
  Frequency bands and other evidence remain links, and so do abstraction links (intents → `social: *`, math-drills).
- Set state derived in the core: a set's belief carries `members: {known}` (members with `p` ≥ 0.8). Every set is
  open (*k known* only) until `closed` exists. Direct evidence for the set stays separate from the count.
- `deck@2` with a `concepts` ref map, for content not made of items. Nothing writes it yet. An entry point's concepts
  are the deck's own plus its items'.
- Queries take several gestalts, so views read `concept@2` and `concept@3` alike.
- Documented: deck members may be generators, and scheduling item traces versus concept state is the view's call.

## Needs design

- A per-distribution table of contents, strictly a closed-world navigation tree. A simpler first version could list
  deck ids directly in `distribution.yml`.
- A `closed` marker on set concepts, because the core cannot infer whether a deck ships every member: then closed
  sets show *k of n* (`members.of`). It is structural, so it is `concept@4`.
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
