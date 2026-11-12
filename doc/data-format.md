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

`gestalts/<name>/v<N>.yml`, in this repo or in a plugin:

```yaml
name: concept
version: 2
fields:
  name: { type: string, required: true }
  aliases: { type: string_list }
merge:                # optional, over what the field types imply
  keys: { name: conflict }
```

Definitions are closed: a prop not listed makes a yml invalid. `id` and `gestalt` belong to every yml.

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

## The core gestalts

| Gestalt | |
|---|---|
| `note@1` | `title`, `main`, `extra`, `aliases`, `tags`, `relationships` (to notes, sources and concepts), `blobs`; all optional |
| `concept@2` | `name`, `aliases`: something that can be learned, in any domain, at any level of abstraction |
| `concept-link@1` | `from`, `to` (concepts), `weight` 0..1: evidence about `from` says this much about `to`; optional `kind`, `source` |
| `practice-event@1` | `subject` (what was practised: an item, or a concept itself) came up in `view` at `at`, with a `rating` from -2 to 2; optional `origin` |
| `flashcard@1` | Markdown `front`; optional `context` (small print with the front), `back`, `extra`, `tags`, `aliases`, `blobs` (`front`, `back`, `audio`), `concepts` (`{concept id: 0..1}`), `sources` (credits, to sources) |
| `source@1` | a citable source: `key` (its BibTeX key, apart from the id), `entrytype`, `title` and biblatex fields (`author`, `date`, `doi`, …); optional `license` (SPDX), `aliases`, `tags`, `extra`, `blobs` |
| `deck@1` | `name`, `title`, `members`: ymls that ship together |
| `fsrs-data@1` | spaced-repetition state for a `target` |
| `practice-session@1` | one session's timing and trials |
| `plugin-install@1` | whether a plugin is on here |
| `view@1` | a vibecoded view: `title`, `source`, `reads`, `writes` |
| `conflict@1` | a value a sync couldn't settle |

`concept@1` (with `parents` and `children`) and `concept-practice-event@1` are still defined, so ymls of them stay valid,
but nothing uses them: concepts form no tree, and events don't copy conclusions.

## Concepts, practice and what a learner knows

`concept@2` knows nothing about any domain. What a "letter" is, and how strongly something practices it, belongs to the
deck or view that writes it. A yml that practices concepts lists them in its own `concepts` prop; `refs` finds them from
the concept's side. Tag a flashcard `no-generic-practice` to keep it out of the generic Flashcards view.

Concepts form no hierarchy. How they relate is said by `concept-link`s: directed (knowing how to say a word is good
evidence of recognising it, not the other way round), weighted, cycles allowed, any number of them, and each a claim
by its `source` (a deck, the user, a model), so several can stand about one pair; they count as their mean.

Practice is logged as it happened, one `practice-event` per answer (or per thing that came up), never as conclusions
about concepts. What it says about concepts is worked out by the core (`crates/core/src/mastery.rs`) from the events,
the `concepts` of their subjects and the links as they are now, so a better graph or model reinterprets all past
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
