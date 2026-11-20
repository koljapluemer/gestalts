# Data format

A data folder holds `notes/<id>.yml`, `blobs/<name>`, and `.gestalts/` (its id, format and GC state).

```yaml
id: 3f2c...          # always equal to the file name
gestalt: note@1      # exactly one, always with its version
title: Anything the gestalt declares
```

A yml is one of:

| State | | Syncs | Queryable |
|---|---|---|---|
| valid | conforms to the gestalt it names | yes | yes |
| tombstone | `{id, deleted}` | yes | no |
| unknown | well-formed, but this device has no definition of its gestalt | yes | no |
| invalid | no `gestalt`, wrong `id`, an undeclared prop, doesn't parse | yes, byte for byte | no |

Writing through the app refuses anything but a valid yml.

## Defining a gestalt

In this repo's `gestalts/`: the core's are `gestalts/<name>/v<N>.yml`, compiled into the core; every other is in a
model package, `gestalts/<package>/<name>/v<N>.yml`, loaded at runtime
([[../architecture/plugins-and-views#Models|Models]]):

```yaml
name: concept
version: 2
fields:
  name: { type: string, required: true }
  aliases: { type: string_list }
merge:                # optional, over what the field types imply
  keys: { name: conflict }
```

Definitions are closed: a prop not listed makes a yml invalid. `id` and `gestalt` belong to every yml. Only the top
level is closed: a `map` checks the `fields` it lists (and `values`, for every key) and takes any other key, so
`{ type: map }` alone is an open map.

| Type | Value |
|---|---|
| `string`, `text`, `number`, `integer`, `bool`, `date`, `partial_date`, `datetime`, `url` | as named |
| `string_list`, `list` (`items`), `map` (`fields`, `values`), `any` | |
| `blob` | a blob name |
| `ref`, `ref_list` | ids of ymls |
| `ref_map` | `{id: number}` |
| `relationships` | `[{to: id, label}]` |
| `blobs` | `[{file: name, label}]` |

Reference types feed the reverse index. `targets` limits what a reference may point at; a reference to nothing is fine,
since targets can be deleted. `labels` limits how many items each label may have.

Text merges by line, lists of references as sets, and everything else per key, conflicting at the leaves.

### Published definitions don't change

Ymls in learners' folders name `name@N`, so once a definition has gone out, what makes a yml valid and how it merges
stays: its structure (fields, `type`, `required`, `min`, `max`, `one_of`, `targets`, `labels`, nested rules, `merge`).
A structural change is a new version. What's presentational (`description`) changes nothing about validity, so it may.
`gestalts/published.yml` holds each definition's structural hash; `cargo test` (and so `mise run check`) refuses a
definition that isn't listed or whose structure differs, and `mise run gestalts:publish` lists new ones. A listed line
may be deleted by hand only for a definition that has never gone out (not deployed, in no deck).

### Definitions as ymls

A gestalt made outside the repo (a teacher's lesson, a workshop draft) is defined by a yml of `gestalt@1`, travelling in
the folder or deck like any other:

```yaml
id: gestalt-t-ab12.noun.1     # gestalt-<package>.<name>.<version>: every copy has the same id
gestalt: gestalt@1
name: t-ab12/noun             # always package/name
version: 1
description: A German noun.
fields:
  word: { type: string, required: true }
  gender: { type: string, one_of: [m, f, n] }
```

- The repo takes a folder's definitions before judging anything else, and when one arrives, changes or goes (a sync, a
  put, a mounted deck) judges that gestalt's ymls again, and only those. A change to `description` alone judges
  nothing again.
- A definition yml is invalid if its id isn't its name, its name has no package, it redefines a gestalt the app has
  (compiled in or from a model package), or it's over the limits: 32 KiB, 200 field rules, rules nested 6 deep.
- Two copies that differ in `name`, `version`, `fields` or `merge` don't merge: that's a sync conflict, one side kept
  whole, never a union of both sides' fields. A `description` merges like any value.
- Who may use which package is up to whoever hands out folders (the teacher app gives each teacher one); the core only
  insists there is one.

## The core gestalts

| Gestalt | |
|---|---|
| `note@1` | `title`, `main`, `extra`, `aliases`, `tags`, `relationships` (to notes, sources and concepts), `blobs`; all optional |
| `concept@2` | `name`, `aliases`: something that can be learned, in any domain, at any level of abstraction |
| `concept@3` | the same, one of a set: `in` (the concept it is a member of) |
| `concept-link@1` | `from`, `to` (concepts), `weight` 0..1: evidence about `from` says this much about `to`; optional `kind`, `source` |
| `practice-event@2` | `subject` (what was practised: an item, an item model, or a concept itself) came up in `view` at `at`, with a `rating` from -2 to 2; optional `origin`, `response` (what kind of answer: a key of the subject's or its model's `responses`), `instance` (which item exactly, in its model's terms) and `ms` (how long it took). `practice-event@1` is the same without the last three; both are read alike, and `logPractice` writes `@1` unless it needs `@2` |
| `flashcard@1` | Markdown `front`; optional `context` (small print with the front), `back`, `extra`, `tags`, `aliases`, `blobs` (`front`, `back`, `audio`), `concepts` (`{concept id: 0..1}`), `sources` (credits, to sources) |
| `multiple-choice@1` | Markdown `prompt` and `options` (`[{text, correct?, response?}]`); optional `instruction`, `concepts`, `responses`, `chance` (how often a guess is right), `model` (the item model it was made by) and `instance` (what it was made from), `tags`, `aliases`, `sources` |
| `item-model@1` | `name`: a procedure that makes items (a generator of exercises); optional `title`, `engine` (the code that runs it), `version`, `params`, `concepts` (what its items practise), `responses` (`{key: {label, concepts}}`: what each kind of answer is evidence about), `chance`, `tags`, `aliases`, `sources` |
| `source@1` | a citable source: `key` (its BibTeX key, apart from the id), `entrytype`, `title` and biblatex fields (`author`, `date`, `doi`, …); optional `license` (SPDX), `aliases`, `tags`, `extra`, `blobs`, `concepts` (`{concept id: 0..1}`, how strongly each comes up in it) |
| `deck@1` | `name`, `title`, `members`: ymls that ship together |
| `deck@2` | the same, plus `concepts` (`{concept id: 0..1}`): what it practises beyond its members' own, for content not made of items |
| `fsrs-data@1` | spaced-repetition state for a `target` |
| `practice-session@1` | one session's timing and trials |
| `plugin-install@1` | whether a plugin is on here |
| `view@1` | a vibecoded view: `title`, `source`, `reads`, `writes` |
| `conflict@1` | a value a sync couldn't settle |
| `gestalt@1` | a gestalt's definition, as data (above) |

`concept@1` (with `parents` and `children`) and `concept-practice-event@1` are still defined, so ymls of them stay valid,
but nothing uses them: concepts form no tree, and events don't copy conclusions.

## Concepts, practice and what a learner knows

A concept knows nothing about any domain. What a "letter" is, and how strongly something practices it, belongs to the
deck or view that writes it. A yml that practices concepts lists them in its own `concepts` prop; `refs` finds them from
the concept's side. Tag a flashcard `no-generic-practice` to keep it out of the generic Flashcards view.

Decks share a concept by writing the same yml under the same id, so their builders share the rule for it. A concept
of something with a code (a country) takes its id from the code, not its name, so a rename keeps it
(`plugins/world-map/tools/concepts.ts`, used by world-map's and flags-practice's builders).

A name says what kind of concept it is. What belongs to a language carries its ISO 639-3 code: `vie:xin chào` is a
word (or expression), `vie: say hello` (with a space) something to say (the phrasebook's intents), `vie-script: sắc` a
part of its writing (a tone mark, a marked letter), and `lang: vie` the language. Concepts no language owns are
`<kind>: <name>` (`function: greet`, `geography: France`). `iso639_3` in `@gestalts/learning` gives the code of a
language tag (`vi`, `pt-BR`).

A set is a concept other concepts are `in` (`concept@3`): a letter is `in` its alphabet (`grc:alphabet`), a word `in`
its language (`lang: vie`), a country `in` `geography: countries`. `in` is single-valued and says membership only:
practising a member is never evidence about the set. What the app believes about a set is its own evidence and,
counted apart, how many of its members are known (their `p` at least 0.8). Sets are open, since the core can't tell
whether a deck ships every member, so a view shows *k known*, never *k of n* or a percentage. Nothing rolls sets up
further ("Greek: 43%"): show sets side by side, or write an explicit concept with evidence links.

A version is written only when it's needed (like `practice-event`): a concept in a set is `concept@3`, any other
`concept@2`. Both are read alike, so a view reading concepts reads both: its manifest lists both, and its queries ask
for both (`gestalt: ['concept@2', 'concept@3']`). The same goes for `deck@2`, written only with `concepts`.

A deck's members may be listed items (facts) or `item-model`s (generators of items). Whether practice of a generated
item is traced per item (scheduling it) or only feeds its concepts is the view's call, not the deck's.

Concepts form no hierarchy. How they relate is said by `concept-link`s: directed (knowing how to say a word is good
evidence of recognising it, not the other way round), weighted, cycles allowed, any number of them, and each a claim
by its `source` (a deck, the user, a model), so several can stand about one pair; they count as their mean.

Four things are kept apart. A **concept** is what is learned and never observed directly: BODMAS, "× and ÷ go left to
right", a letter; a misconception is a concept too, phrased as the skill it lacks ("rounding, not cutting off"). An
**item** is what a learner meets and answers, which produces evidence: a `flashcard`, a `multiple-choice`, a video. An
**item model** (`item-model`) is a procedure that makes items, like a generator of exercises: its items point to it by
`model` and practise what it says; it is not a concept. A **practice event** is what happened when a learner met an
item. An item or item model may name `responses`, the kinds of answer it can tell apart (a typical mistake), each with
the concepts that answer is evidence about: an event naming one also counts for those concepts. An item or item model
may say its `chance`, how often a guess is right (0.25 with four options), so a right answer on it counts for less.

Practice is logged as it happened, one `practice-event` per answer (or per thing that came up), never as conclusions
about concepts. What it says about concepts is worked out by the core (`crates/core/src/mastery.rs`) from the events,
the `concepts`, `responses` and `chance` of their subjects (or their subjects' models) and the links as they are now, so a better graph or model reinterprets all past
practice. Views get beliefs (a mean and spread per concept) for the concepts they show, live, with `useBeliefs`; they
never load the events. The model and how it keeps up are described in that file.

A note relating to a `concept` says something about it, labelled `sheds light on` by default. A claim about a `source`
is a note relating to it, labelled `source` by default; a locator goes in the label (`source p. 34`). Names in `author` and `editor` are `family, given` (`family, suffix, given`; without a comma, one
name never split), and are a `list`, not a `string_list`, so their order survives a merge. `doi` is kept lowercase
without a resolver prefix and `isbn` as ISBN-13 digits, so `where` finds a source by either. `@gestalts/sources`
has the model, BibTeX in and out, duplicate finding and merging.

## The Zettelkasten

Notes form Luhmann's Zettelkasten through `relationships`, so placing a note writes only that note: `follows` X puts it
next after X in X's sequence, `branches from` X starts a sequence under X. There's no inserting between two notes, only
branching. The note tagged `zettelkasten-root` starts it all, and a note tagged `no-zettelkasten` is kept out without
being placed. Whatever doesn't add up (two places, two roots, a place that's gone or isn't placed, a cycle) is shown,
never repaired behind the user's back; the core's outline (`crates/core/src/outline.rs`) says how each case reads.
`plugins/zettelkasten` is the view.

## Publishing a deck

`mise run publish-data <dir>` names blobs by content, deletes unused ones and writes `index.json`, the listing a static
host needs. Every yml in a deck must be valid.
