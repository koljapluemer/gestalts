# Gestalts

A gestalt is a named, versioned shape a note may have.
Each version lives in its own file, `gestalts/<name>/v<N>.yml`. The core's are in the repo's `gestalts/`, embedded at
build time (add new ones to `BUILTIN` in `crates/core/src/gestalt.rs`); a plugin's are in `plugins/<id>/gestalts/`,
loaded at runtime by the apps and the connector. Each gestalt has one owner: those more than one plugin uses are the
core's.

A note is a **candidate** for a gestalt when:
- it has every tag in `requires_tags`, and
- it has at least one of the `trigger_fields`, if any are listed.

A candidate **has** the gestalt when every rule holds. A candidate that breaks a rule gets lints instead, which the editor shows. A note can have several gestalts at once.

```yaml
name: pronunciation-card
version: 1
requires_tags: [pronunciation-card]
trigger_fields: []          # e.g. [url] for gestalts without a tag
fields:
  title: { type: string, required: true }
blobs:                      # counts by label; `_` = unlabelled
  audio: { min: 1, max: 1 }
relationships:
  reviews: { min: 1, max: 1 }
```

Field types:
- Strings: `string` (one line) and `text`.
- Numbers: `number` and `integer`.
- `bool`, `date` (`YYYY-MM-DD`), `datetime` (ISO 8601), `url`.
- `partial_date`: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, or a range of two joined by `/` (either side may be open).
- Collections: `string_list`; `list`, whose `items` rule every element follows; and `map`, which takes nested `fields`,
  or a `values` rule every value follows (for maps keyed by data, like typst `assets`).
- `blob`: a blob name. Every blob a note uses this way, or embeds as `![[name]]` in `main`, `extra` or a card, must
  also be listed in its `blobs`; the editor lints it otherwise. That's what keeps a blob from being collected.
- `any`.

Field options:
- `required`.
- `min` and `max`: the value for numbers, the item count for lists.
- `one_of`.

## Lenses

How the note component shows a gestalt's notes ([architecture.md](architecture.md#the-note-component)). Without a
lens, a gestalt's fields show in a section of their own, each by its type; a plugin may add one per gestalt it owns
or uses (`lenses` in `plugin.yml`, a `defineLens` export):

```ts
export const AppointmentLens = defineLens({
  gestalt: 'appointment@1',
  title: 'Appointment',
  priority: 1,                                   // higher first among a note's lenses
  fields: { date: { label: 'when', Field: DateField } },  // also `order`, `hidden`
  offered: (note) => [...],                      // the unset fields offered while editing (default all)
  seed: (value) => value,                        // a new note's value, once the required tags are added
  Summary: ({ note }) => …,                      // one short line in compact and inline views
  afterSave: async (repo, { key, before, after }) => {},  // with the plugin's own access
});
```

Every note shows the lenses of all the gestalts it has or is a candidate for; a field claimed by several shows once,
at the first. A new note seeded with a gestalt (`createNote({ gestalt })`) gets its required tags (`seedFor`) and
its lens's `seed`.

## Merge

How a gestalt's notes merge in sync, in its definition. Each strategy is a pure function of base and both sides
(`crates/merge`):

```yaml
merge:
  whole: { newest_by: [card.lastReviewAt, card.reps] }   # fsrs-state: pick one side as a whole
```
```yaml
merge:
  keys:                                                  # practice-session: per key
    events: { union_by: at }
    active_ms: max
```

| strategy | |
|---|---|
| `conflict` | a value changed differently on both sides is a conflict |
| `map` | per key, recursing (the default below the top level) |
| `set` | a list as a set: additions from either side kept, removals from either side dropped |
| `union_by: <field>` | a list of items identified by a field, all of them kept (append-only logs) |
| `list_by: <field>`, optional `item: <strategy>` | a list of items identified by a field, each merged (`cards` by `id`) |
| `text` | line-level diff3; a conflict only where both changed the same lines |
| `newest_by: [paths]` | the side with the greater value at the first path that differs; works without a base |
| `max`, `min` | the greater or smaller value; a missing one doesn't count |

A note's policy is the default (`tags`, `relationships`, `blobs` as sets; `main`, `extra`, `tasks` as text; the rest
per key) with the rules of every gestalt the note is a candidate for, on any of the three sides, laid over it. Where
two gestalts disagree, the value falls back to `conflict`. A conflict keeps the side whose value sorts greater, never
"the local one", so all devices agree.

## Conflicts

What no rule settles becomes a `conflict@1` note: `note` (the key, also `conflict-of` it), `path` (keys, and
`{by, id}` for an item of a list), `base`, `kept` (what the note now holds) and `lost`; `raw` when they're whole note
texts. It's keyed by the note, the path and the values, so two devices recording the same conflict write one note.
A delete against an edit records the edit with an empty path, `kept` being the tombstone.

- The note editor and the connector settings show them (`widgets/Conflicts.tsx`): keep this, use the other side,
  or edit a text value. Resolving writes the value into the note and deletes the conflict.
- A perspective may resolve its own conflicts in code with `resolveConflicts(repo, query, decide)`
  (`@gestalts/sdk`, `conflicts.ts`). `decide` must be deterministic: devices resolving the same conflict the same
  way write identical notes, which merge cleanly.

Conflict copies from before (`<key>.conflict-<timestamp>`) stay ordinary notes.

## Deleting

Deleting writes a tombstone ([data-format.md](data-format.md)). A relationship can make a note die with its target:

```yaml
relationships:
  reviews: { min: 1, max: 1, dies_with_target: true }   # fsrs-state, practice-state
```

Deleting a card then deletes its learner state too, and a state written on another device meanwhile stays hidden
while its card is a tombstone. In a layered repo, a tombstone in the user's layer hides the deck note under it, and
copy-on-write never copies it back.

## Versioning

- Consumers always ask for `name@N`.
- A breaking change gets a new `vN+1.yml`. The old file stays, so existing perspectives keep working, and a note may have both versions.
- Never change the meaning of a published version.

## Defined

| gestalt | |
|---|---|
| `flashcard@1` | tag `flashcard`, `front` and `back` |
| `appointment@1` | tag `appointment`, `date` |
| `link@1` | a well-formed `url` |
| `pronunciation-card@1` | (plugin alphabet-pronunciation-via-visual-cognates, in gestalt-plugins) tag `pronunciation-card`, `title` (the term), blob `audio`, optional blob `image`, optional `lang` |
| `fsrs-state@1` | tag `fsrs-state`, one relationship `reviews`, `model` (e.g. `FSRS-7`), `last_rating` 1–4, `card` (a ts-fsrs v6 card), optional `facet` |
| `recurring@1` | tag `recurring`, `weekday` (`mo`…`su`), optional `until` (partial date) |
| `daily@1` | tag `daily`, `date`; keyed `stableId("daily", date)`, so one note per date across devices |
| `project@1` / `issue@1` | tag `project` / tag `issue` with at least one `project` relationship |
| `published@1` | `publish_route` and `publish`: a note's text as published, apart from `main` |
| `template@1` | tag `template`, `format` (`jinja-html`), `source`; superseded by `template@2` |
| `source@1` | tag `source`, `title`, `citekey`, `entrytype` and biblatex fields (see [Sources](#sources)) |
| `canvas@1` | tag `canvas`, `nodes` (each `id`, `x`, `y` and `text` or `note`), one `canvas-of` relationship; superseded by `canvas@2` |
| `canvas@2` | a `canvas` key with `nodes` (as in v1) on the note it's about; its linked notes are `on-canvas` relationships of that note |
| `template@2` | a `template` key `{format, source, name}` on the note it renders |
| `cards@1` | a `cards` key: a list of `{id, front, back}`; `id` (dsl's `card_id` of the front when made) is the `facet` of the card's `fsrs-state` |
| `typst-document@1` | (plugin typst) tag `typst`, `source`, `assets` (path → `blob`), blob `pdf` (at most one), `document-of` at most one |
| `term@1` | tag `term`, `title` (the term), optional `lang`, `translations`, `transliteration`, `examples` (each `text`, `translation`, `credit`), `value` (a numeral's number); blobs `image`, `audio`, `doodle` at most one each; alternate spellings in `aliases` |
| `sentence@1` | tag `sentence`, `title` (the sentence), optional `lang`, `translations`, `transcription`, `credits` (each `for`, `text`), `parts` (each `content`, `translations`, `transcription`, `examples`, `term` = a `term@1` id), `gaps` (each `word`, `at`, `distractors`), `start`/`end` in seconds with at most one `segment-of` |
| `quote@1` | (plugin quotes) tag `quote`, `main`, optional `attribution`; may `cites` a `source@1` |
| `country@1` | tag `country`, `title`, `code` (ISO alpha-3), optional `alpha2`, `priority`, `world_map` (map), blobs `flag` and `geometry` (a GeoJSON feature) at most one each; `distractor` relationships to other countries; keyed `stableId("country", code)` in decks, so decks holding a country merge |
| `scene-object@1` | tag `scene-object`, `title`, optional `props`, `hold` (maps), blob `model` (glb) or `image` |
| `interaction@1` | tag `interaction`, `action`, optional `effects`, `instructions` (lang → sentences); one `actor`, at most one `target` |
| `practice-state@1` | tag `practice-state`, one `reviews`, `model` (a scheduler other than FSRS: `ebisu`, `streak`, …), `state` (map), optional `facet` |
| `practice-session@1` | tag `practice-session`, `app` (perspective id), `started`, optional `ended` (datetimes), `active_ms`, `trials`, `events` (each with `at`); random key, one writer |
| `settings@1` | tag `settings`, `scope` (perspective id), further fields as the scope defines; keyed `stableId("settings", scope)` |
| `plugin-install@1` | tag `plugin-install`, `plugin`, `source`, optional `version`, `enabled`; keyed `stableId("plugin", id)` |
| `conflict@1` | tag `conflict`, `note`, `path`, `recorded`, optional `base`, `kept`, `lost`, `raw`; one `conflict-of` ([Conflicts](#conflicts)) |

Relationship labels with a meaning: `inline` (a `[[reference]]` in the note's text, kept in step with it), `card-of` (a flashcard extracted from a note, the old form of `cards`), `canvas-of`
(the old form of a note's canvas) and `on-canvas` (each note on a canvas), `document-of` and `cites` (a Typst document or quote, its note and the sources it cites),
`template-of`, `reviews` (learner state and the note it's for), `segment-of` (a sentence and the recording it's spoken
in), `distractor` (a country easily confused with this one), `member` (a group and its notes), `actor` and `target`
(an interaction and its scene objects).

## Folded parts

A note's canvas, template and cards were attached notes (`canvas@1` `canvas-of`, `template@1` `template-of`,
`flashcard@1` `card-of` it). They're keys on the note now, so they merge per key with the rest of it. Migrated data
isn't rewritten. Readers take the note's key first, else the attached notes (`fold` in `@gestalts/sdk`). Every
save through the new form writes the key and retires the attached notes: tag `retired` plus
`folded: {into: <host id>, hash: <sha256 of the part as folded>, card: <id>}` (`card` for cards only). A retired
note whose part no longer matches `hash` was edited after the fold (another device, the source editor), and the
editors offer it back: "Use that version" or "Keep this one".

## Sources

`source@1` is the biblatex model: `entrytype` (`article`, `book`, `incollection`, `inproceedings`, `thesis`, `report`,
`online`, `software`, `misc`), names (`author`, `editor`) as `family, given`, `family, suffix, given` or one name
without a comma (an organisation), lists (`publisher`, `institution`, `organization`, `location`), partial dates
(`date`, `urldate`) and literals. Braces protect case as in BibTeX (`{NASA}`), `$…$` is math. `bib_extra` keeps
imported fields the model has no place for, so they're written back on export. The `citekey` should be unique;
the Sources pane flags duplicates.

`crates/core/src/bib.rs` reads BibTeX (legacy types and fields mapped: `journal` → `journaltitle`, `year`+`month` →
`date`, `phdthesis` → `thesis` + `type`), writes biblatex, finds the source an entry probably is (a shared DOI, ISBN or
eprint decides; else title, first author and year, loosely), merges an entry into a source, and lists the keys a Typst
document cites. The client exposes it as `bib`.

## Learner state

Learner state is a separate note that `reviews` the card. It is not stored in the card itself. That way content can stay read-only (shipped in a plugin's deck) while each learner's progress lives elsewhere.

State notes (`fsrs-state@1`, `practice-state@1`) have stable keys, so two devices rating the same card write one note:
`stateKey(gestalt, target, facet?)` in the client (`state_key` in the core), which is `stableId(gestalt, target)` or,
for one facet of a note (a cloze level, a map exercise), `stableId(gestalt, "<target>/<facet>")`. States saved
before this keep their random keys. Logs go in `practice-session@1` notes instead, one per session.

Perspectives share this through `@gestalts/learning` (`learning.ts`, `session.ts`, `practice.tsx`):
- `fsrsStates(notes)` indexes `fsrs-state@1` notes by `{target, facet}`. Facets of a note are separate, and a state
  without `facet` is the whole note's. If two notes hold the same one (a random key next to the stable one after a
  sync), the later review wins, then more reps, then the greater key, so every device agrees.
- `review(scheduler, prev, grade, now)` is plain FSRS. A perspective may adjust the result (Greek alphabet makes a card
  due right away when it starts or stops struggling). `saveReview(repo, facet, prev, next, log)` writes it under the
  existing key or `stateKey`, and logs the review.
- `usePracticeSession(app)` writes this page's `practice-session@1` notes. A session starts at its first trial, so
  opening a perspective writes nothing, and it includes the activity just before that trial. Any key or pointer press
  while the page is visible counts as activity. A gap between two activities counts toward `active_ms` up to 60 s,
  and time while hidden counts nothing. After 10 minutes without activity the next trial starts a new session.
  `ended` is the last activity, updated on every write, so a closed tab still leaves a finished session.
  `shown()` marks when a card appears; `trial(event)` appends `{at, ms, …event}`, `ms` being the time since `shown()`.
- A review event is `{at, ms, kind: fsrs-review, target, facet?, rating}`. It replaces the review log py-fsrs kept in
  its state file. Other apps add their own `kind`s.
- Quotes: each cloze level `n` (its last `n` words hidden) is the facet `"<n>"` of the quote; a quote's lowest new or
  due level comes up, so it's learned from its end. Changing a quote's words starts it over.
- Flashcards (Learn): a card of a note (`cards`, or a `flashcard@1` `card-of` it) is the facet `<card id>` of that
  note; a `flashcard@1` of its own is reviewed as the whole note. dsl's review state wasn't carried over, so its cards
  start new.
