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
