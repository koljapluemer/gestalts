# Where gestalts live, and gestalts as data: discussion

Not built. Where the thinking stands, from a discussion on 2026-11-15 that started at authoring decks
([[deck-authoring|Deck authoring]]).

## Now

- The core's gestalts are compiled in: `crates/core/src/gestalt.rs` embeds `gestalts/*/v*.yml` with `include_str!`,
  into the core, the wasm and the phone app.
- A plugin's come at runtime: `crates/node/src/manifest.rs` and `packages/vite` hand them to `builtin_with(extra)` as
  YAML. Redefining a gestalt is refused.
- A yml whose gestalt this device doesn't know is unknown: it syncs, but can't be queried.

So a definition already reaches the core as data at runtime; only where it comes from is tied to a view's plugin.
That tie is the problem: `plugins/world-map` holds a view, the `map`, `map-exercise` and `country-group` gestalts, and
a deck, so any second view on those gestalts depends on another view.

## Options

1. **All in the core.** Domain gestalts go to `gestalts/`, compiled in. One registry, nothing unknown between our own
   apps. But every new gestalt means a new core, wasm and phone app, only the repo can add gestalts, and the core
   holds every domain's model.
2. **Owned by plugins** (now). Self-contained plugins; a model tied to one view, and view-on-view dependencies as soon
   as a second view uses it.
3. **Model packages beside plugins**, e.g. `gestalts/geography/{map,map-exercise,country-group}`, loaded at runtime as
   plugins' gestalts are now; only the core's compiled in. Views and decks depend on models, models on nothing. A
   distribution names its models, or they follow from its views' `reads` and its decks. Mostly moving folders and the
   loaders and checks. Still only the repo adds gestalts.
4. **Definitions as data**: a `gestalt@1` gestalt, compiled in, whose ymls are definitions, travelling in decks and in
   the user's folder like any yml.

3 now and 4 when gestalts have to come from outside the repo, with 3 done so that 4 later only changes where
definitions come from: namespaced names for anything new, and published definitions checked to never change.

## Option 4

Content (notes, cards, concepts), shipped content (decks) and even views (`view@1`) are already data in a folder.
Definitions aren't, which means:

- data outlives its schema: a folder with `map-exercise` ymls, opened in an app without world-map (the phone, another
  distribution, an older version), can't use them, and nothing in the folder says what they are
- a vibecoded view can't bring a type of its own: a workshop draft for nouns with gender and plural has to misuse
  `flashcard` or wait for a gestalt in the repo and a release
- only the repo can introduce a type, so a deck from someone else can only use types the build already has

With definitions as ymls:

```yaml
id: gestalt-geography.map-exercise.1     # from name and version: every copy has the same id
gestalt: gestalt@1
name: geography/map-exercise
version: 1
fields:
  model: { type: ref, required: true, targets: [item-model] }
  country: { type: string, required: true }
  zoom: { type: number, min: 0 }
  distractors: { type: string_list }
  concepts: { type: ref_map, min: 0, max: 1, targets: [concept] }
```

- a deck lists its definitions among its `members`, so mounting it brings them
- the first write of a gestalt into a folder copies its definition there too, so the folder describes itself and the
  phone can read it without the view
- a workshop draft is a `view@1` with its own `gestalt@1`, shared together
- definitions are edited with the same editor as content

On open, the core takes the `gestalt@1` ymls of every layer first, then judges the rest by them. The core's own
reasoning stays on compiled-in gestalts: `gestalt`, `deck`, `conflict`, `plugin-install`, and those mastery and the
outline read (`note`, `concept`, `concept-link`, `practice-event`).

## Its costs

### Code

- **Load order.** The worker parses every yml on open anyway; definitions first (an id prefix spares a second parse),
  then the rest.
- **Definitions arriving mid-session** (a sync, a mounted deck) move every yml of that gestalt from unknown to valid
  or invalid: reindex per changed gestalt as well as per changed id, and recompute subscriptions on it. Moderate, with
  a test at the 12k scale of `crates/core/src/repo.rs`.
- **Copying definitions into the user's folder** on write. They're small and never collected.
- **Refusing** a data definition of a compiled-in gestalt: one check in `builtin_with`.
- **Limits** on a definition's depth, fields and size.
- **Migrating** plugins' gestalts into ymls. Backwards compatible: an older app sees `gestalt@1` ymls as unknown, and
  those sync byte for byte.
- **Namespacing, shallowly.** Today's names are in learners' folders and can't be migrated, so they stay as they are;
  only definitions from outside the repo need a namespace. A change to `valid_gestalt_id` and a convention.

### Contained design

- **Definitions don't merge.** Decks merge texts sharing an id (`merge_texts`), sync merges by the gestalt's rules;
  merging two field sets makes a schema nobody wrote. `gestalt@1` needs its own rule: identical copies agree, different
  ones are a hard error, in health. Little code, but in the merge and sync paths.
- **Draft vs. published.** A definition changes while it's being made, and mustn't once it has gone out in a deck or a
  sync. Some marker for that (a draft version, a draft namespace that never syncs, or published once in a deck), and
  the editor warns when tightening a draft makes ymls invalid.

### Real trouble

**Identity once copies travel.** If `name@version` is the identity, everything depends on nobody ever changing a
published text, and breaking that shows up elsewhere: a fixed typo in a published description, and every learner
folder holding the old copy now has two texts for one id; under the hard-error rule their exercises vanish from every
view until it's settled. Nothing is destroyed, but it happens in folders nobody else can reach, and an outside
author doesn't run our publish step.

So a definition splits in two:

- **structural**: fields, types, `required`, `min`, `max`, `targets`, merge rules. What makes a yml valid and how it
  merges. Never changes under one `name@version`; copies agree when their hashes do. A structural change is a new
  version, and publish and `mise run check` refuse one without it.
- **presentational**: `description`, field descriptions, which field titles a yml, widget and `format` hints, labels of
  an `enum`. Changes nothing about validity, so it may change after publishing and merges like any yml.

Nearly every edit after publishing is presentational, and the rest needed a new version anyway. The split is worth
having under option 3 as well: it decides whether the display hints of [[deck-authoring|Deck authoring]]'s editor can change once a
definition has shipped.

**Collisions between authors, only once there are outside ones.** A namespace needs an owner. A deck shipping its own
`geography/map-exercise@1` with another structure would, under the hard-error rule, make everyone's exercises of the
real one unqueryable. First-seen-wins decides differently per device; priorities by source are a half-made authority;
a hash named in every yml has no collisions but every yml carries it and "the same type" becomes interpretation. The
clean answer is a namespace per source (a deck's or an author's id), checked against where a definition came from.
None of this arises while every gestalt is ours, so it's designed last.

## Summary

| | |
|---|---|
| load order, reindexing, copying, migration, limits | a few days of ordinary code |
| definitions don't merge, draft vs. published | contained design, tested carefully in the merge path |
| identity of published definitions | real, mostly settled by the structural/presentational split and hashes |
| collisions between authors | real, only with outside authors; can wait |

The question that decides between 3 and 4: will gestalts be defined outside this repo, by vibecoded views,
third-party or learners' decks, or without releasing the phone app for each?
