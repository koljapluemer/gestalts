# Authoring decks (a CMS): discussion

Not built. Where the thinking stands, from a discussion on 2026-11-15. Gestalt placement, which this depends on, is in
[[gestalt-definitions-as-data|Gestalt definitions as data]].

## Who it's for

Authors making and maintaining decks, before they are published. Not learners: views like `flashcard-manager`
manage a learner's own ymls and stay bespoke product views. A learner's edit of a deck yml lands in their own folder
and shadows the deck's (`Layered` in `crates/core/src/storage.rs`), so it never flows back, and a later deck update to
that yml doesn't reach them. That is a product question of its own.

## Where decks are now

- A deck is a folder of ymls judged by the gestalts, mounted read-only under the user's folder; decks holding one id
  are merged (`crates/core/src/decks.rs`). Schemas, validation (`health`), references, blobs and overlays exist.
- No deck is hand-written. Each is built by a script in its plugin's `tools/` from data elsewhere (phrase lists,
  Stembridge's exports, `world-map/tools/data`), which deletes and rewrites it. An editor of deck ymls would be
  overwritten by the next build. Two builders read another plugin's data: flags-practice's reads world-map's
  `tools/data` (country names, regions) and its concept rule; vietnamese-typing-practice's copies concepts from the
  phrasebook's built Vietnamese deck.
- `packages/vite` bundles every deck into the app build; only the list of decks is fixed at build time. The client
  reads any published folder (`Static` in `crates/peer`).
- Learners' `fsrs-data`, practice events and beliefs point at deck ids.

## No external CMS

A hosted headless CMS (Sanity, Directus, Payload) would define every gestalt a second time, add a database beside the
plain text, and still need an export into decks. A git-based one (Keystatic, Decap) keeps things static but also
duplicates the schemas, handles our reference types badly, and still needs `publish-data` in CI. It's a fallback only
if people without a node have to edit.

## An editor from the schemas alone

The field types say most of what a form needs: `text` a Markdown editor, `string_list` a `ListInput`, `ref` an
`ItemPicker` within `targets`, `ref_map` a picker with a 0..1 weight, `relationships` a picker with a label, `blobs`
slots within `labels`; `required`, `min`, `max` and nested `fields` are declared. The core is the validator: an
invalid write is refused with its reason. `refs` gives every gestalt a "referenced by" panel.

By volume, most deck ymls fit (concepts, links, flashcards, sources, decks, most of multiple-choice and item-model).
What doesn't:

- display hints the definitions lack: which field titles a yml, a `description` per field, `enum`, `derived` (filled
  by a tool, read-only), `format` (`code`, `json`) for `text` and `map`
- cross-field keys: `multiple-choice` `option.response` is a key of its own or its model's `responses`
- domain values: `map-exercise.country` and `distractors` are codes in the map's geometry blob
- derived content (`map.geometry`, `viz.built`), which stays with its tool
- bulk work: a table over many ymls (a column per scalar field), not only a form per yml

Previews come from the plugin's own view, opened at an `item` param (a convention every learning view would take).
Whether the hints can be edited after a definition ships depends on [[gestalt-definitions-as-data|Gestalt definitions as data]]'s
structural/presentational split.

## Where it sits

A local authoring app on a node, like the workshops: the node serves one deck folder as its data folder, so edits are
files in the working tree, git is the history and review, and shipping stays commit and `mise run deploy`.

- top layer: the deck being edited; read-only layers: every other deck, so pickers find shared concepts and sources.
  The edited deck must not be mounted under itself, or deleting from it would write a tombstone into it.
- the editor keeps `deck@1` `members` up to date
- the editor is app code, not a view: it writes every gestalt, needs the definitions, and publishes; a view gets none
  of that. Domain editors (a map to pick distractors on) are ordinary views on their gestalts, listed only in this
  app's distribution
- a backend runs `publish-data`, `health`, git status, and the pipeline below
- the node refuses a folder without `.gestalts/format`: a deck mode in the node, or the marker in deck folders with
  `packages/vite` leaving `.gestalts/` out (not yet decided)

Open: its own app or a mode of learning-workshop (separate seems right: drafts in the browser vs. a repo folder on the
node), and its name.

## Building a deck from scratch: pipelines

World-map as the example: raw Natural Earth data, reduced and projected, regions excluded, and then exercises,
distractors and groups curated over time.

```
raw sources ──fetch──▶ cache (gitignored, by url + sha256)
                          │
pipeline params ─────▶ stages (scripts, cached by inputs + params + script hash)
                          ▼
                    generated base
                          │  three-way merge (crates/merge, the gestalts' rules):
curation ────────────────▶│  base = last generated, ours = the deck, theirs = newly generated
                          ▼
                    the deck (committed, published, bundled as now)
```

- **Sources** are declared per deck (`url`, `sha256`, `license`), fetched into a gitignored cache, so a fresh clone
  builds the same thing. The `source@1` credit comes from the same declaration.
- **Stages** are the scripts in the plugin's `tools/`, in any language, with declared inputs, outputs and params. The
  params have a schema, so the generic form edits them. The node runs stages as cancellable jobs that stream their
  events, like the workshop agent's. World-map: `reduce` (simplify, `exclude`), `project` (today's d3 part),
  `generate` (concepts, item models, default exercises).
- **Pipeline decisions vs. content decisions.** "Fiji isn't on the map" changes the geometry, so it's a param of
  `reduce`. "Fiji is on the map but not practised" is deleting its exercises. Distractors, zoom, priority and groups
  are content.
- **Curation is the deck itself.** After a regenerate, the new output is merged into the deck against the previous
  output: curated distractors stay, deleted exercises stay deleted, and where both changed there's a conflict to
  settle, as in sync. The base can be regenerated from the recorded params and source hashes instead of being
  committed. `countries.json` and `groups.json` would be turned into the curated deck once and then retired. A
  disabled exercise that should keep its settings needs a prop for it, not a deletion.
- **Agents** are one more stage, proposing yml changes that are reviewed as a diff, never written directly.

What a plugin brings the authoring app: sources, stages with params, and optionally views for its gestalts. The app
brings the runner and cache, params forms, the generic editor and table, merge conflicts, health, publish and the git
diff.

The world-map deck was exported once from sam-learns-things' world-map CMS; its UI and reduction step are worth
reading before designing a map editing view.

## Going live without a redeploy

Worth it only once decks have their own release cadence or come from others; for one author a redeploy is minutes.

1. Decks on a site of their own (with CORS for the app origins); the registry names absolute URLs. Changed decks go
   live; new ones still need an app deploy.
2. A `catalog.json` read on open: `source`, `url`, `title`, `version`, and what it needs (plugin, gestalts with
   versions), so an older app skips a deck it can't read instead of loading unknown ymls. New decks appear without a
   deploy as long as the app has their view.
3. Optionally, checking the catalog's version on focus and reopening the repo with the new decks, as `usePluginRepo`
   already does when the mounted decks change.

What has to hold then:

- ids never change or get reused; publish refuses to drop a published id unless confirmed; removals are tombstones
- blobs (content-addressed) uploaded first, then `ymls.json` and `index.json`, then the catalog; old blobs collected
  later
- short revalidation on `catalog.json` and `ymls.json`, immutable caching on blobs

For yourself, a node can mount a deck folder from the repo as a live deck, so you can practise against a deck while
you write it.

## Editing views and where gestalts live

A domain editor (a map to curate exercises on) shouldn't be a second `.tsx` in a plugin, or a plugin that edits
another plugin's data. Both hide the real problem: `plugins/world-map` holds a view, a data model (its gestalts) and
content (its deck and tools), so a second view on `map-exercise@1` depends on another view's plugin. Elsewhere views and
gestalts are many to many: `flashcards`, `flashcard-manager`, `phrasebook` and others all use the core's
`flashcard@1`.

With the model and content out of the view's plugin, an editing view is a peer like `flashcard-manager`, named for what
it does, and authoring is the same views pointed at a deck folder instead of the user's. Which decks a distribution
mounts would then be listed in its `distribution.yml`, not implied by an installed plugin. Where gestalts go is
[[gestalt-definitions-as-data|Gestalt definitions as data]]; where decks and their pipelines go (top-level `decks/`, or with their
gestalts per domain) is open.

## Order

1. Settle where gestalts live.
2. Pipeline declaration, runner, cache and source fetching; world-map ported onto it with a real `reduce`.
3. The three-way merge of generated output into the curated deck, and its conflicts.
4. The generic editor and table.
5. A map view for curating exercises.
6. The deck catalog, when decks need their own cadence.
