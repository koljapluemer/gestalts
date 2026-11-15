# plugins

One folder per plugin ([`doc/plugins.md`](../doc/plugins.md)), usable by any app: an app's `distribution.yml` says
which it ships. A view imports only `@gestalts/view`, `@gestalts/kit`, `@gestalts/learning`, `@gestalts/sources` and npm
packages, never another plugin (`oxlint.config.ts`).

Decks are read-only, and two decks that hold the same id are merged, so a concept shared between them keeps the
relations of both. After editing one by hand: `mise run publish-data plugins/<id>/decks/<deck>`.

`alphabet-pronunciation-trainer/tools/build_greek_deck.py` generates the Greek deck's flashcards and concepts. What a Greek
"letter" is lives there, and only there.

`phrasebook/tools/build_phrase_decks.py` (`uv run`) generates the phrase decks from `tools/phrases/<language>.yml`: one
concept per phrase, shared by every way of saying it (to whom, how politely), and links into the concepts no language
owns (`function: greet`, `situation: restaurant`, `social: politeness`), so decks meet there. Cards adapted from
Wikivoyage credit it on the card (`sources`); each deck's `LICENSE.md` says the rest. The Vietnamese pronoun variants
marked `own: true` were written for the deck and want a native speaker's check.

`math-drills/tools/build_decks.py` (`uv run`) generates the `stembridge-*` decks, one per topic, from the topic exports
of [Stembridge](https://github.com/koljapluemer/stembridge) (a sibling checkout, `../stembridge` by default): a topic
becomes an `item-model@1` with a `multiple-choice@1` per exercise (TeX in `$…$`), and the concepts it touches become
`math: <name>` concepts with their `part-of` links, shared between decks. Stembridge owns the exercises, the concepts and
what each distractor means; this tool only translates. After Stembridge regenerates (a new topic, changed exercises):
`mise run math-drills:decks`, which rebuilds every `stembridge-*` deck, drops those whose topic is gone and publishes
them. CC BY 4.0, credited on every item.

`world-map/tools/build-deck.ts` (`mise run world-map:deck`) generates the world-map deck from `tools/data`, exported
once from sam-learns-things' world-map (which countries have which exercise, zoom levels, distractors, groups) with
Natural Earth's shapes. It projects the shapes with d3-geo, so the view gets SVG paths and only scales and moves them.
Each country is a `geography: <name>` concept, its id keyed by its code (`tools/concepts.ts`, shared with
flags-practice), each kind of exercise an `item-model@1`, each exercise a `map-exercise@1` (a gestalt of the plugin's,
with `country-group@1` and `map@1`).

`flags-practice/tools/build-deck.ts` (`mise run flags-practice:deck`) generates the flags deck from `tools/data`: the
flags of sam-learns-things' learn-flags (iso-country-flags-svg-collection, minified with svgo), `countries.json` (each
ISO alpha-2 code's name, its code in world-map's geometry, and `skip` with why a flag isn't asked: one that is
another's, like France's territories) and `lookalikes.json` (groups of flags that are confused). Each flag is a
`flag@1` practising a `flag: <name>` concept, linked both ways (weight 0.1) to world-map's `geography: <name>`
concept of the country, whose yml it writes the same as world-map does. A flag's wrong options are its look-alikes,
else its region's countries from world-map's `tools/data/countries.json`.
