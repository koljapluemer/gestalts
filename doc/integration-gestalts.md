# Gestalts for integrating dsl and sam-learns-things

The gestalts that let every dsl tab and every sam-learns-things mini app run on notes with all of its features. The
gestalts below are defined (shapes in [gestalts.md](gestalts.md)); the `renders` and `viz` keys get defined with the
Portfolio and Viz blocks ports of [next-steps.md](next-steps.md#ports). dsl notes already migrate (`~/SCRIPTS/143_dsl_to_gestalts`);
sam-learns-things has no migration yet.

## Principles

- **Content and learner state are separate notes**, as `fsrs-state@1` already does. Content ships as read-only decks
  (copy-on-write, like loops-for-learning). State and logs are written by one learner.
- **State notes have stable keys**: `stateKey(<gestalt>, <target id>[, <facet>])`, as `daily@1` does. Then two devices
  rating the same card write one note, not two.
- **Merge is per top-level key**, so append-heavy data (logs) goes into notes that only one device writes: one per
  session, never one per day.
- **Shape, not use.** A gestalt says what the content is (a term, a sentence, a country). How it's practised is up to
  the perspective, so one Hebrew clip deck can serve script practice and a listening drill.
- **A tag is enough when there are no rules.** Explorations, goals and `suggest-*` need a `tagsAll` query, not a
  gestalt.
- **A note's own parts are keys on it, not attached notes** (canvas, cards, renders, viz builds); see
  [gestalts.md](gestalts.md#folded-parts). Worker-owned keys never conflict with the user's.

## New gestalts

| gestalt | shape | replaces / used by |
|---|---|---|
| `term@1` | tag `term`, `title` (the term), `lang`, `translations` (list), `transliteration`, `examples` (list of `{text, translation, credit}`), optional blobs `image`, `audio`, `doodle`; alternate spellings in `aliases` | top-vocab words, 20-words words, with-videos vocab, dont-translate (image + `aliases` as the expressions), arabicnumbers numbers (`title` the numeral, `value`), typingpractice entries |
| `sentence@1` | tag `sentence`, `title` (the sentence), `lang`, `translations`, `transcription`, `credits` (list of `{for, text}`), `parts` (list of `{content, translations, transcription, examples, term}`, `term` optionally a `term@1` id), `gaps` (list of `{word, at?, distractors}`); optional `start`, `end` (seconds) with a `segment-of` relationship | infinitesentences, egyptiansentences, saetze (one gap, one distractor), with-videos snippets (`segment-of` a `link@1` note for the video, with `lang`), tprboard/al-kutshina instructions |
| `quote@1` | tag `quote`, `main`, `attribution`; optional `cites` relationship to a `source@1` | quotes |
| `country@1` | tag `country`, `title`, `code` (ISO alpha-3), `alpha2`, `priority`, blob `flag`, `world_map` (map: the exercise switches and zooms); distractors as `distractor` relationships to other countries; groups as plain notes with `member` relationships | world-map, learn-flags |
| `scene-object@1` | tag `scene-object`, `title` (its name), `props` (map), `hold` (map), blob `model` (glb) or `image` | tprboard objects, al-kutshina items |
| `interaction@1` | tag `interaction`, `action`, `effects` (map: sender/receiver effect or reaction code, replacement image), one `actor` and at most one `target` relationship (scene objects), `instructions` (map: lang → list of accepted sentences) | tprboard relationships and task texts, al-kutshina capabilities, affordances and quests |
| `practice-state@1` | tag `practice-state`, one `reviews` relationship, `model` (`ebisu`, `leitner-patience`, `streak`, `arabicnumbers-sr`, …), optional `facet`, `state` (map, as the model defines it) | every scheduler that isn't FSRS: tprboard (Ebisu), 20-words memorize board, triangle and simplify topic streaks, arabicnumbers levels |
| `practice-session@1` | tag `practice-session`, `app` (perspective id), `started`, `ended` (datetime), `active_ms`, `trials`, `events` (list of maps, each with `at`; the app defines the rest); random key, written by one device only | the shared activity log and time entries, and every per-app event table: hebrewscript and minimal-pairs events (confusion matrices), typing line attempts, currency trials, world-map and triangle learning events, 20-words review events, with-videos snippet views and reflections, egyptiansentences highscores, FSRS review logs (`kind: fsrs-review`, see [gestalts.md](gestalts.md#learner-state); py-fsrs kept them in the state file) |
| `settings@1` | tag `settings`, `scope` (perspective id); key `stableId("settings", scope)`; any further fields | synced preferences: target/native language, daily sentence goal, TELEX/VNI, Graph pins. Machine-specific settings (export paths, Ollama URL, the claude CLI) stay in the connector's config |
| `renders` (key) | `{<kind>: {input_hash, blob, thumb}}` on the rendered note, written by a connector plugin (Chromium); `input_hash` covers the note's text, its blobs and the renderer's version | portfolio card collages, then visible on devices that can't render them (a phone); replaces dsl's `~/.cache/dsl-crud/cards` |
| `viz` (key) | `{<name>: {version, built_from, meta, page, thumb, sources, previous}}` on the note holding the fence; `page`, `thumb`, `sources` (an archive of the project) are blobs | dsl viz blocks (`files/thea/`). The ```` ```thea brisk-river-3 ```` fence names its entry; a `thea@1` plugin service runs the claude CLI |

Generated-exercise apps (currency, simplify-expressions, triangle-congruence) have no authored content. Their topics
become plain deck notes (title, explanation in `main`), so `practice-state@1` has something to `reviews`.

## Changes to existing gestalts and conventions

- `fsrs-state@1`: an optional `facet`, with the key above, for cards that are one facet of a note. Examples: a
  quote's cloze level, a world-map exercise (`find-in-neighborhood:2`), a top-vocab level, an infinitesentences gloss,
  a tprboard instruction text. Notes without `facet` keep their meaning. Review state from dsl (py-fsrs) and
  sam-learns isn't migrated; their cards start new.
- `pronunciation-card@1` already fits hebrewscript and minimal-pairs clips (`title` the transcript, blob `audio`,
  `lang`); minimal-pairs' `nativeScript` goes in `aliases`.
- `flashcard@1` covers just-flashcards as is; cards in other notes are a `cards` key (`cards@1`, each with an `id` for its `facet`; [gestalts.md](gestalts.md#folded-parts)).
- [data-format.md](data-format.md) has two conventional fields that dsl notes already carry after migration: `extra`
  (more Markdown, inline references count as in `main`) and `tasks` (a note about the note, for the Tasks tab).

## dsl tabs

| tab | built on |
|---|---|
| Daily, Calendar, Projects, Sources, Canvas, Canvas2Typ, Published + site | existing gestalts (`daily`, `appointment`, `recurring`, `project`, `issue`, `source`, `typst-document`, `published`), `canvas@2` and `template@2` keys on the host |
| Learn | `cards@1` key (and `flashcard@1`) + `fsrs-state@1` with `facet`, review logs in `practice-session@1` |
| Portfolio | tag `portfolio` + `template@2`, tag `card` notes with `renders` |
| Graph | relationships; pins in `settings@1`; hiding by tags `no-graph` |
| Viz blocks | `viz` key |
| Tasks | `tasks` field, plus notes with lints |
| Explorations, Goals, Tags, Suggest, Queue, Float, Questions, Desk | tags and relationships only. Hiding uses `gestaltsNone` in `Query` (e.g. Queue leaves out appointments, sources and dailies) |

Not gestalts but connector plugins: semantic search (Ollama embeddings, a cache), the Questions LLM picker, PDF export
and collages (Chromium), the continuous `.bib` / site / portfolio exports.

## sam-learns-things apps

| app | content | state |
|---|---|---|
| ancient-greek-alphabet | `pronunciation-card@1` (done) | `fsrs-state@1` |
| hebrewscript, minimal-pairs-practice | `pronunciation-card@1` | `practice-session@1` events |
| just-flashcards | `flashcard@1` | `fsrs-state@1` |
| quotes | `quote@1` | `fsrs-state@1`, facet = cloze level |
| top-vocab, dont-translate | `term@1`, top-vocab's example sentences `sentence@1` | `fsrs-state@1` (facets) |
| 20-words | `term@1` (user-authored) | `practice-state@1` (board) + `fsrs-state@1` |
| with-videos | `link@1` (video) + `sentence@1` segments + `term@1` | `fsrs-state@1` per term and video, session events |
| infinitesentences | `sentence@1` with `parts` | `fsrs-state@1` per gloss; learned sentences and daily counts derive from sessions |
| saetze, egyptiansentences | `sentence@1` with `gaps` | sessions (highscores) |
| arabicnumbers, typingpractice | `term@1` | `practice-state@1` / sessions |
| world-map, learn-flags | `country@1` (+ geometry as a blob on a deck note) | `fsrs-state@1` per country and per exercise |
| tprboard, al-kutshina | `scene-object@1` + `interaction@1` | `practice-state@1` (Ebisu), sessions |
| currency, simplify-expressions, triangle-congruence | generated; topic notes | `practice-state@1`, sessions |

The cross-app stats page (trials, active time per day) aggregates `practice-session@1` notes.

## Open questions

- **Volume.** The decks hold thousands of notes each (minimal-pairs 4000 clips, hebrewscript 2250, saetze 1630,
  egyptiansentences 1500; infinitesentences more), and they load into the one `Repo` index. What gets slow is I/O, not
  memory: `Static` fetches each note separately, and sync rereads and reindexes every note. A deck bundled into one
  file and incremental sync and reload would fix that.
- **Blob sizes.** Audio decks are 50–150 MB. Copy-on-write only copies what was rated, which helps; offline use needs
  the "download the whole deck" action from [next-steps.md](next-steps.md#other).
- **Migrating sam-learns-things** means exporting Dexie Cloud tables into state and session notes. Ids must map to
  deck note ids, so decks need stable keys first (`stableId(<deck>, <catalog key>)`).
