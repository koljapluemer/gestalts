# Architecture

```
crates/merge          symmetric, rule-based 3-way merge of YAML values; knows nothing of notes
crates/core           notes, gestalts, queries, sync, tombstones, blob collection; the Storage port. No IO.
crates/fs             Storage adapter: a folder on disk
crates/peer           Storage adapters over HTTP, native and wasm: another device's node, static decks; natively,
                      pairing with a node on the home network
crates/wasm           the core in the browser: its JS API, OPFS storage, and storage the page is handed (a native app's)
crates/device         a device's own folder synced with the node it paired with: the native side of the Gestalter on
                      a phone, on a thread of its own
crates/node           gestalts-node: serves a folder on localhost (and to paired devices on the home network), hosts
                      workers, plugin manifests (plugin.yml, schema 2) and the gestalts of core + plugins; apps embed
                      it, `gestalts-node` is it headless
gestalts/             the core's gestalt definitions (data, embedded into the core)
packages/sdk          @gestalts/sdk: the perspective port (Repo interface, hooks, host capabilities, slots)
packages/kit          @gestalts/kit: the public components, on the sdk only
packages/learning     @gestalts/learning: FSRS by facet, practice sessions, learnable cards
packages/client       the host's core in the browser: the wasm-backed Repo, opening, syncing; over a native app's
                      folder (`/tauri`: Tauri IPC)
packages/ui           the host: panes from pane notes, plugin installs, the capability frame, connector settings
packages/vite         @gestalts/vite: builds an app with its plugins (`virtual:gestalts-plugins`, decks, Tailwind sources)
plugins/<id>/         domain bundles, each a package `@gestalts-plugin/<id>`: plugin.yml, their gestalts, decks, ui/ and worker/
```

The apps live in repos of their own, next to a checkout of this one (they link its packages and crates by path until
they are published):
- **gestalter**: the host with every plugin, panes as tabs (`distribution/`), and its desktop app around the node
  (`desktop/`, `gestalter`), which serves that build. On Android (`android/`, `distribution-android/`) the same host
  runs in the system WebView, its notes in the app's storage, synced with the paired desktop.
- **loops-for-learning**: the host with the learning plugins, one pane at a time; hosted, for learning.

Plugins that are content rather than a part of the paradigm (the learning mini tools) live in **gestalt-plugins**,
grouped by where they come from (`sam-learns/<id>/`). A plugin there is an interaction (find countries on a map, read
a script aloud), and its topics are decks. They import only the public packages, like the plugins here.

Where it goes from here (the repos, the apps, what isn't built yet): [next-steps.md](next-steps.md).

## Core (Rust, native and wasm)

- `Storage` (port): list/read/write/delete notes by key, list/read/write blobs by name. `?Send` so browser adapters fit.
- Adapters: `FsStorage` (disk, atomic writes), `Opfs`, `Static` (read-only, a published data folder with `index.json`) and `Peer` (another device's node), both over HTTP in `crates/peer`, native and in the browser; `Layered` (any number of read-only decks + a writable top, copy-on-write), `Tracked` (knows its notes' hashes, for sync), `Memory`.
- `Repo`: loads every note into an index (parsed YAML, gestalts, lints) and answers `Query {gestalt, gestaltsNone, tagsAll, tagsNone, keys, where}`, skipping tombstones. Its gestalts are the core's plus those of the app's plugins, loaded at runtime.
- `merge_note` / `sync` (in phases, reading only notes whose hashes differ, against a `SyncBase`): see [node.md](node.md#sync); deletes are tombstones ([gestalts.md](gestalts.md#deleting)).
- `upstream`: copy-on-write from published decks into the user's storage, see below.
- `blobs`: which blobs notes use, and collecting the rest ([node.md](node.md#sync)).

The browser never parses YAML itself: `packages/client` calls the wasm core, which also lints drafts (`repo.inspect`) for the editor.

Where the notes are (`NotesIn` in `packages/client/src/repo.ts`):
- `{dir}`: in OPFS, synced with a connector if one is set (`mode: 'sync'`)
- `{node}`: the folder a node serves, written over HTTP, its changes from `/events` (`mode: 'direct'`)
- `{native: 'tauri'}`: the folder of the native app around the page (`mode: 'paired'`). The core in the page still
  holds the index (the sdk port's reads are synchronous), over a `HostStorage` whose calls are the app's commands
  (`WasmRepo.openWith`). The app (`crates/device`) syncs the folder with the node it paired with and sends what
  changed, which the page rereads, as with `/events`. There are no node services there, so panes needing one are
  hidden.

## Data flow in the apps

| app | storage | with the desktop app |
|---|---|---|
| Gestalter | the folder, through the node that serves the page (`Peer`), over the decks of its installed plugins | always: it is served by it |
| loops-for-learning | OPFS `demo/` (its name from when it was the Demo) over its plugins' decks; a word or country is copied into OPFS when first practised | only the OPFS layer syncs with the folder |

loops-for-learning works without the desktop app; connecting to it is remembered per browser. The Gestalter works
only with it running ([node.md](node.md#serving-an-app)).

### Copy-on-write from a deck

A learner's data must stand on its own: a folder synced from loops-for-learning holds the rated words, not just review states pointing at words that live elsewhere. So user space is **closed under references**:
- Writing a note through `Layered` copies every deck note it references (`relationships`), as the decks have it, with that note's blobs and, in turn, its references. Rating a word writes an `fsrs-state` note, which copies the word. A country copies the countries it's confused with (`distractor`), and theirs: one answer on the world map copies most of the world.
- `pull_upstream` runs on open and after each sync. It copies whatever is still missing (e.g. references that arrived by sync) and brings copies up to date.

A plugin has any number of decks, each mounted as `<plugin>/<deck>` (its `source`), and installs can switch decks
off one by one. **Decks that hold the same key hold the same thing**: decks key their notes by what they are (a
country `stableId("country", <ISO code>)`), so the world and Africa decks hold one Kenya. Where several mounted decks
hold a key, `Layered` reads the merge of their texts by the gestalts' merge rules, without a base, in the order of
their sources (`upstream::Decks`): tags and relationships unite, equal values pass. A value they disagree on keeps the
merge's canonical winner and is reported in `upstreamReport().deck_conflicts`, never written: decks are read-only.

Each copy is the merged text plus an `upstream` trailer naming the decks it came from (see
[data-format.md](data-format.md)). When the decks change (an edit, or a deck holding the note mounted or unmounted):
- an untouched copy is replaced with the new upstream text
- an edited copy is left alone and reported as diverged
- words nobody rated simply stay upstream, so they update for free
- a copy none of whose decks is mounted stays as it is

The repo's `upstreamReport()` says what the last check did; loops-for-learning logs it to the console. A tombstone in user space hides the deck note under it, and is never copied over.

## Packages and plugins

`oxlint.config.ts` enforces who may import whom (eslint-plugin-boundaries):

- `@gestalts/sdk` imports nothing of ours. It's the perspective port: the `Repo` interface (notes cross it parsed;
  only the host's core parses YAML), the hooks (`useQuery`, `useData`, `useNote`, `useBlobUrl`, `useSettings`),
  `definePerspective`, `definePane`, host capabilities (`useHost`), `Slot`, `defineLens`, the field and note helpers
  (`fold`, `inline`, conflicts, `noteGestalts`, `seedFor`), and natives the host provides (ids, hashes, BibTeX). No wasm, so it can later run in a
  sandboxed frame.
- `@gestalts/kit` imports only the sdk, in layers, each from below: `primitives/` (CodeMirror, `Markdown`,
  `MarkdownEditor`), `components/` (`NoteLine`, `YamlEditor`, `Modal`), `widgets/` (`Relationships`, `MediaGallery`,
  `NotePicker`, `SourcePicker`, `Conflicts`, the note search), `note/` (`Note`, see [the note
  component](#the-note-component)), `views/` (`SearchSidebar`, `SearchLayout`, `useUrlList`). Tailwind + daisyUI +
  lucide are the real primitives.
- `@gestalts/learning` imports only the sdk.
- A plugin's UI (`plugins/<id>/ui/src`) imports only the sdk, the kit and learning: never another plugin, the client
  or the host. `mise run check-plugin-standalone <id>` builds one outside the workspace against the packed public
  packages, as in a repo of its own.
- `@gestalts/client` (the core in the browser) builds on the sdk; the host (`packages/ui`) on client, sdk and kit.
- Apps load plugins only through `virtual:gestalts-plugins`.

### Plugins

A plugin is a domain bundle in `plugins/<id>/` (or a repo of its own, as gestalt-plugins') with a `plugin.yml`
(schema 2):

```yaml
schema: 2
id: alphabet-pronunciation-via-visual-cognates
version: 1.0.0
host_api: 2
gestalts: [pronunciation-card@1]           # owned here, defined in gestalts/<name>/v<N>.yml
uses: [fsrs-state@1, practice-session@1]   # owned elsewhere: a data dependency
decks:                                     # starter content, published-deck format, mounted as <plugin>/<deck>
  - { id: greek-alphabet, title: Ancient Greek, path: decks/greek-alphabet }
panes:
  - { id: practice, title: Alphabet pronunciation, entry: ui/src/index.ts#PracticePane }
  # a pane may need node services: `requires: { services: [typst@1] }` (Canvas2Typ)
slots:                                     # e.g. canvas: { slot: note-view, gestalt: canvas@2, entry: … }
lenses:                                    # how the note component shows a gestalt's fields (one per gestalt)
  - { gestalt: pronunciation-card@1, entry: ui/src/index.ts#CardLens }
access:
  read: { gestalts: [pronunciation-card@1, fsrs-state@1, practice-session@1] }   # or `all`; `tags_all` for plain notes
  write: { gestalts: [fsrs-state@1, practice-session@1] }
worker: …                                  # optional, see node.md
```

- **Gestalts** have exactly one owner: the core, or one plugin. Those that more than one plugin uses are the core's;
  a plugin owns only its own domain (`pronunciation-card@1`, `quote@1`, `typst-document@1`). The apps and the
  connector load every plugin's gestalts, so their lints and merge rules apply, even for a plugin that's uninstalled.
- **Built-in plugins**: explorer, canvas (Canvas; the `note-view` slot of `canvas@2`), typst (Canvas2Typ, and the
  `typst@1` worker), calendar (Daily, Calendar; the appointment, recurring and daily lenses), projects, queue, float,
  questions, graph, sources (the source lens), learn, quotes (the quote lens), ollama (no panes: the `ollama@1`
  worker). gestalt-plugins has the
  learning ones with decks (learn-world-map, alphabet-pronunciation-via-visual-cognates).
- **Plugins use each other through services**, never by importing one another: a worker offers a service by a
  versioned id (`typst@1`, `ollama@1`), whichever plugin ships it, and any pane can call it (`repo.service(id)`). A
  pane needs one (`requires.services`, below) or uses it when it's there (`services` in `definePerspective`, a client
  or `undefined`; Questions with `ollama@1`). Code they share goes in `@gestalts/kit` (its Ollama client and
  `ModelDownload`). Not covered yet: a plugin can't declare a service it uses optionally, so the distribution has to
  ship the plugin that offers it; service calls aren't scoped by `access`; and paired devices reach no services.
- **Distributions**: an app is the host plus the plugins it depends on (`@gestalts-plugin/<id>` in its
  `package.json`) and `distribution.yml` (`id`, `default_panes`, `install_ui`). The `id` keys the local tabs,
  so it stays once released: `gestalter-desktop`, `loops-for-learning`, `gestalter-android`. `@gestalts/vite` turns them into
  `virtual:gestalts-plugins`: each plugin's manifest, its gestalts, its decks (served under `decks/<plugin>/<deck>/`) and loaders
  for its UI modules. The app builds with any list. The same preset dedupes React (packages may be linked from a
  sibling checkout) and replaces `@gestalts-sources;` in the app's CSS with an `@source` per package, at its real
  path: Tailwind doesn't reliably scan through pnpm's symlinks.
- **Installs** are `plugin-install@1` notes (`stableId("plugin", id)`), seeded for the distribution's plugins once
  a new folder has synced, so they sync like notes. The Gestalter's plugin menu enables, disables, uninstalls and
  reinstalls them, showing what each may read and write, and switches a plugin's decks on and off (`decks: {<id>:
  false}` on the install note). Uninstalling unmounts its decks (after a reload); the user's copies stay unless "also
  delete my copies" asks to delete the notes copied from its decks alone (a note another plugin's deck holds too
  stays).

### Panes and the host

- **Tabs are local** (`host/tabs.ts`): the Gestalter's tabs live in this browser's localStorage, under
  `gestalts-tabs:<distribution id>`, as `{v: 1, tabs: [{id, pane, title?, params}]}` in tab order. A tab is an
  instance of a pane with its own `id` and settings (`params`), so a pane can be open more than once. `?pane=<tab id>`
  selects one (a pane ref works too, for links). They aren't notes: opening, closing and moving a tab never waits on
  the repo, and tabs didn't gain much from syncing.
- **Per distribution**: each distribution keeps tabs of its own, so a phone doesn't get the desktop's. Without any
  stored, its `default_panes` are the tabs; once the user closes them all, they stay closed. Installs stay global.
- **Requirements**: a pane may need node services (`requires.services`). The host asks the node's `/services`
  (`useServices()` in `@gestalts/client`, every 10 s): a pane whose service the node doesn't offer, or without a
  node, isn't offered under +; one whose service isn't running is greyed there. An open tab that lacks one is
  dimmed and its pane runs under a line saying what's missing (Canvas2Typ still edits without `typst@1`).
- **The capability frame** (`host/PaneFrame.tsx`) runs each pane with the host's capabilities (`useHost()`):
  `openNote` (the note over the pane) and `createNote(seed)` (a new one; it resolves to its key, or null when given
  up), both kept in the URL as `?overlay=note:<key>` or `?overlay=new&seed=<json>`, so Back closes them; `pickNote`,
  `navigate`, `setTitle`; `slot`, the views installed plugins registered (`<Slot name gestalt noteKey/>`); and
  `lenses`, the installed plugins' lenses, loaded with the host. A perspective hides what the host doesn't offer.
- **Access**: the pane's repo is scoped to its plugin's `access`. It reads only notes in `read`, and writes only
  notes that are in `write` before and after; a write scoped by gestalt must give a note that has the gestalt, so
  one breaking its rules is refused. Slot views, and a lens's `afterSave`, get their own plugin's scope.
- `debug/` (`@gestalts/ui/debug`): `ErrorBoundary` (around each pane), `DebugLogButton`. See [debugging.md](debugging.md).

## Canvas and Typst

A canvas is the `canvas` key of its host note (`canvas@2`); its linked notes are `on-canvas` relationships of the
host, so they travel with it. An old `canvas@1` note (`canvas-of` the host) is shown until the first change folds it
into the host and retires it ([gestalts.md](gestalts.md#folded-parts)). While it's open, the page's reducer is the
only truth (`plugins/canvas/ui/src/model.ts`); `CanvasSaver` writes whole snapshots, debounced, one at a time, held
while dragging. If the stored nodes change to something this page didn't write (a sync, the source editor), it stops
writing and offers to reload; changes to the host's other keys don't count. A host whose YAML doesn't parse makes
the canvas read-only.

The note component edits a note's cards and template (kit `note/Parts.tsx`), folding attached ones in on the first
save the same way. Since a note can be written by these, by its fields and by the source editor at once, the source
editor saves a draft as a 3-way merge against the text it started from (`repo.merge3`, the merge a sync does). If
both changed the same value, it asks before overwriting.

The Typst editor compiles through the connector's `typst@1` service (`plugins/typst`, which also has the Canvas2Typ pane; it shows the canvas through the `note-view` slot, so notes are added to a canvas in the Canvas pane), sending the source, the
document's `assets` (path → blob, fetched by the worker) and a bibliography of the sources it cites
(`/sources.bib`). Without the service the document is still editable and shows its last built PDF. Build PDF stores
the PDF as a content-addressed blob labelled `pdf`; saving adds a `cites` relationship to each source cited.

## The note component

Wherever a note is shown or created, it's kit `Note` (`packages/kit/src/note/Note.tsx`); panes configure it and none
renders a note on its own. Defaults are full capabilities: anything not switched off is there.

| Parameter | Default | |
|---|---|---|
| `noteKey`, `seed` | | the note; without one, a new note from `seed` (`NoteSeed`: its value so far, a gestalt, a relationship from another note, a preset) |
| `render` | `full` | `simple`: the note as read (its media and gist, see below), the tools floated beside it; `inline`: one line (`NoteLine`, the lenses' summaries, a lint icon, the tools), for list rows |
| `modes` | view, edit | `split` also: the text's editor with it rendered beside it. The toggle hides when only one is offered; a new note only edits |
| `defaultMode`, `mode`, `onModeChange` | view | the mode, when the caller keeps it (the Graph's and Canvas's one card in edit) |
| `persist` | | a key keeping the mode for the browser tab's session; the caller picks the scope (`explorer:<key>`, `daily`) |
| `commit` | `blur` | `blur`: edits are written as focus leaves the note, on Mod-s, and when it closes; `explicit`: Save and Discard. A new note is explicit: Create (Mod-Enter) |
| `relationships` | on | `readonly`: the rows only; off: none (the Graph, whose edges are them) |
| `lenses` | all | `name@version` of the gestalts whose fields show open; the note's others are behind "also" |
| `tools`, `tagToggles`, `extraTools` | | switch tools off (or `edit` on in `full`); tag toggles (the Queue's `no-q`); the page's own tools, first in the row |
| `compact` | | no properties beyond the gestalts; read, as `simple` (its title opens it), edited, its one line in the header: Graph and Canvas cards |
| `gist` | | what the note as read shows (`GistOptions`): `{ tasks: false }` where they're beside the point (Float) |
| `onOpen`, `onEdit`, `onDelete`, `onDeleted`, `onCreated`, `onCancel`, `onClose`, `onEscape` | | `onDelete` replaces the repo's delete (the Graph's, with undo) |

What it shows, top to bottom:
- **Header**: the title, whole (read, in `full`), the lenses' summaries, the tools
  (media, link a note, add a gestalt, tag toggles, edit, edit the source, delete, the page's own), the save state,
  the mode toggle or Save/Discard, close.
- **Gestalts**: the ones the note has, filled, and those it's a candidate for but breaks (`noteGestalts`), outlined,
  their lints on hover.
- **Properties** (`note/layout.ts`, `layoutOf`): tags, then a section per gestalt (focused ones first, then by lens
  priority, the ones it has before candidates, then by name), each with the fields of its gestalt no earlier section
  showed, then the fields no gestalt claims. A field claimed by several gestalts shows once. Read, a section shows the
  fields the note has and the required ones missing (marked, with their lints); edited, every field, or those its
  lens `offered` for the note (a source's, by its entry type), with "add a field". Each field is shown and edited by
  its lens's `Field`, else by its type (`note/fields/DefaultField.tsx`: inputs for strings, numbers, dates and URLs,
  a toggle, chips for string lists, a select for `one_of` and blobs, YAML read by the core for the rest).
- **Media**, then the **text**: read, the gist's text parts (`tasks`, `main`, cards, `extra`; the others are
  properties); edited (`note/Body.tsx`), `tasks`, `main`, `extra` and the title, whichever gestalts claim them, as
  Markdown: `[[` completes a note and inserts its id, Mod-click (on touch screens a button) opens a reference; then
  the cards and template (`note/Parts.tsx`). Then the other files, and the relationships.

### The gist: a note as read

`noteGist` (`packages/sdk/src/gist.ts`) is what a note reads as, whatever it has, as Markdown blocks in reading order
and never cut: the title as a heading, `tasks`, then the parts its fields make (`main`; a `front` and `back`, a rule
between; each of its `cards` so; a `url` as a link; `publish`; a canvas's text nodes), then `extra`, smaller below a
rule. Parts go by the fields a note has, not by its gestalts. A lens adds its own (`Lens.gist`: the fields it uses
up, its blocks, its line), ahead of the built-in ones: a quote reads as a blockquote with who said it, a source with
its authors and year, an appointment, recurring item or daily note with its date. `GistOptions` leave out the title
(the full view shows it in the header), `tasks` or `extra`, or keep to some fields (`only`: the full view's text, as
the properties show the rest). Kit `NoteGist` renders it; a note with none of these shows nothing (Float doesn't draw
it).

`noteLine` is the gist in one line, for **list rows only** (search results, relationships, `inline`, the labels of
`[[references]]`, sorting): the title, else a lens's line, else the first line of `main` as plain text, else a part's
(a front, a link, a canvas's first text), else of `extra`. Never the note's YAML: `noteLabel` falls back to
`Untitled <gestalt>`. Wherever a note is meant to be read (Float, Queue's simple cards, Graph and Canvas cards), it's
the whole gist.
- **Edit the source**: the whole note as YAML with its parse errors and lints (`note/SourceEditor.tsx`), for what the
  fields don't show; entered after the fields' draft is written, so there's one draft at a time.

A note has one draft (`note/useNoteDraft.ts`): edits gather in it, and `commit` writes them onto the note as it is by
then, field by field (`applyValueDraft`): a field the note changed meanwhile to something else isn't written over;
it asks (Overwrite, Discard). A new note is written with its relationship from `seed.relate.from`, then its staged
media. After a write, the lenses of the gestalts the note now has hear of it (`afterSave`: a quote whose words
changed starts its practice over).

Presets (`seed.preset`) are how much a new note shows: `capture` (the search's +: title and text), `gestalt` (the
Calendar's new appointment: its lens open, the others behind "also"), `full`. "More…" turns a smaller one into
`full`, keeping what was typed.

Images and videos are attached from the toolbar (on touch screens also from the camera), or by pasting or dropping
them into the text: written at once for a stored note, after it for a new one, as content-addressed blobs. Images
are downscaled to 1920 px and re-encoded as WebP (lossless from PNG and BMP; GIF and SVG kept as they are). Videos
up to 250 MB are stored as they are. Removing one takes it off `blobs`; the blob itself stays.

Every save keeps the note's `inline` relationships in step with the `[[references]]` in `main`, `extra` and its cards,
and lists each `![[embed]]` in `blobs` (`syncInline`, `packages/sdk/src/inline.ts`). The copy-on-write closure and
backlinks then follow prose links like any other relationship. A source save is written as typed unless that changes
something.

`Relationships` lists a note's own relationships (`→`), its inline references (`⇢`) and its backlinks (`←`, `⇠`).
The backlinks come from one index per repo version, built from every note's relationships and from the references
in their text, so notes edited elsewhere count too. Explicit rows can be detached and relabelled, and the adder
relates a picked note in either direction. Each change is written at once, to whichever note holds the relationship.
Inline rows are edited in the text.

| Pane | Configuration |
|---|---|
| over any pane (`openNote`) | full, view/edit, persisted per note |
| new note (`createNote`) | the seed's preset, Create, Cancel, "More…" |
| Explorer | full, view/edit, persisted per note; the search's + is a capture |
| Daily | full, edit first, persisted per view, no delete, the daily lens open |
| Calendar | inline, with the lenses' summaries; + is a new appointment on the day, ↻ a recurring item on its weekday |
| Graph | compact, view/edit with the mode from the graph's interaction (one card in edit), no relationships, its own delete (undo) and hide; grip, pin and unpin-others as extra tools. A new note (double-click, the toolbar, a drag onto empty canvas) is `createNote`; from a drag, related from the dragged note |
| Canvas | linked notes compact, view/edit with the mode from the canvas, relationships read-only, no delete; grip, to-text and detach as extra tools |
| Projects | inline: a project with its issue count and + issue (`createNote`, related to it) as extra tools; an issue with the think/build toggle (tag `suggest-think-and-sketch`, those first) |
| Queue | simple or full (the toggle beside Next), the `no-q` tag toggle |
| Float | simple, the `no-float` tag toggle; its edit tool opens the note full in a modal, holding the stage |
| Questions | full, the mode kept for the session (`e` edits) |
| Sources | the open source: full, edit first, the source lens open; BibTeX update and the citekey beside it |
| Quotes | added with the quote lens (`createNote`), edited over the pane |

## Learn

The Learn pane (`plugins/learn`) reviews every flashcard by FSRS, as dsl's Learn tab did. The cards come from
`learnableCards` (`@gestalts/learning`): each card in a note's `cards`, each `flashcard@1` that is
`card-of` a note without `cards` yet, and each `flashcard@1` of its own. A card of a note is reviewed as the facet
`<card id>` of that note, so its state stays put when the card is folded in; a flashcard of its own as the whole note.
`pickNext` shows a random due card, else a random new one, never the one just rated unless it's the only one; the
card shown stays until it's rated, even if a sync changes the picks. The front, then Reveal (Space), then front and
back with Again, Hard, Good, Easy (1–4); the counts are due · new · all. Reviews go through `saveReview` and the
`learn` practice session. A rating shows the next card at once: `useLocalReviews` lays the new state over the
query's until the query has it, and the save runs in the background (it may wait behind a sync); if it fails, an
alert says so. The Greek alphabet works the same way. Deleting a card deletes its `fsrs-state` too (`dies_with_target`).

## Daily and Calendar

`plugins/calendar`, as dsl's tabs were:
- **Daily** edits today's `daily@1` note in the text editor. A day starts at 04:00 local time, so at 01:00 it's still
  yesterday's note, and an open tab moves on within a minute. The note is keyed `stableId("daily", date)` and created
  when there's none (another `daily@1` of that date counts too), so two devices creating it make one note.
- **Calendar** lists `appointment@1` and `recurring@1` notes by day or over a From..To range (this week, Sunday to
  Saturday, by default); view, day and range are in the URL. Keys: ←/→ a day (or the range's length), `t` today/this
  week, `a` add, `d`/`r` day/range view. An appointment dated a month, a year or a range longer than a day shows
  once, under "Ongoing", not on every day. `+` adds an appointment on that day by its title; an item opens in the
  host's editor.
- **Past appointments**, at the bottom: those whose date ends before today (a month-only one once the month is
  over; an open-ended range never), deleted together after a confirmation. Recurring and undated notes are kept.

## Queue

`plugins/queue`, as dsl's tab was: three random notes of yours, and Next (`n`) to draw others. The batch is kept
outside the pane, so it stays while other tabs are open. The toggle beside Next shows the notes simply (label and
body) or in full (the editor), kept for the browser session. The pool (`POOL` in `ui/src/queue.ts`, edited there)
leaves out what dsl's did (appointments, recurring items, sources, dailies, explorations), bookkeeping (learner
state, sessions, settings, installs, conflicts) and deck content (countries, terms, sentences, cards, quotes, …),
which deck panes practise. Each note's hide toggle tags it `no-q`, which leaves it out of later draws; toggling
again is the undo. A hidden note stays on screen until the next draw; a deleted one drops out.

## Float

`plugins/float`, as dsl's tab was: random notes of yours drifting across the stage, a new one every 2.5 s, each
crossing in 12–25 s, drawn 20 at a time. The pool (`POOL` in `ui/src/float.ts`) is Queue's, without its
explorations rule. The filter below (`/`) keeps the notes the search finds and starts a new draw. A card stops under
the pointer; its edit tool opens the note in a modal, which holds the stage still, and the card is gone when it
closes. The hide toggle tags a note `no-float`: it drifts on, and isn't drawn again.

## Questions

`plugins/questions`, as dsl's tab was: a random note of yours that states something (`>` or `~` in `main`) and is
linked loosely (at most one relationship besides inline links), not tagged `no-questions`, with up to 3 of the 11
questions in `ui/src/questions.ts`. Each answer relates the note, under the question's label (`solves`, `assumes`,
`so:`, …), to a note picked from the search or a new one made from the text typed (`{main: text}`). The note shown
stays, answered or not, until Skip (`s`), and the ones skipped aren't drawn again this session; Disable (`d`) tags it
`no-questions`; `e` edits it.

With `ollama@1` (the `ollama` plugin, on a node), `gemma3:4b` picks the 3 questions that fit the note best, prompted
by `PROMPT` beside the questions; its picks are kept per note text for the page's life. Without the service, the
server or the model, the first 3 are asked and a line says why; a missing model can be downloaded from there.

## Graph

`plugins/graph`, as dsl's Graph tab was: pinned notes and their relationships on a canvas (React Flow, laid out by
ELK), with the search beside it.
- **The graph** is built in the page from the notes alone (`ui/src/graph.ts`): the notes in `SCOPE` (yours: as dsl's,
  without appointments, recurring items, sources, dailies or explorations; without bookkeeping and deck content; nor
  notes tagged `no-graph` or `retired`, nor ones whose YAML doesn't parse), and between them each explicit relationship
  and each `[[reference]]` (an inline edge, dashed, left out where an explicit one goes the same way). A breadth-first
  search from all pins at once shows each pin's notes within its depth, at most 28 relationships per pinned note, 12
  per note further out and 140 notes, the farthest left out first; the graph says what it left out.
- **Pins** (note key → depth) are kept in `settings@1`, scope `graph`, so they sync; the open pane's own state is the
  truth, written back shortly after a change. A search result's pin button pins it with two hops; the toolbar pins a
  random note, a random one without relationships, a random search result, or all results (the first 100, alone).
  Right-click the canvas to search and pin there. A badge under a card counts its related notes not shown; clicking
  it pins the note with one hop.
- **Edits** are note writes: dragging a card's dot onto another card relates them (the label asked for; empty is
  unlabelled), onto the canvas makes a new note related from it; double-click makes one alone. A label opens a form
  to relabel or remove the relationship, written to the note holding it; an inline edge opens its note, where it's
  edited in the text. A card's tools pin, step its depth, unpin the others, open it in the host's editor, hide it
  (tag `no-graph`) and delete it. Delete, hide and removing a relationship can be undone from the toast, the last one
  only; undoing a delete writes the note (and those that died with it) again, which brings it back.
- **Layout** (`layout.ts`, `useElkLayout.ts`): cards are measured first, then ELK runs once, seeded with the previous
  positions so unrelated cards stay put; new cards appear next to the note last acted on. A dragged card keeps its
  spot and its neighbours move out of the way, without running ELK again.

## Search sidebar

Search runs client side over every note:
- Every query word must match a word of the note, or a prefix of one. Case and accents are ignored.
- Rarer words weigh more, and exact words beat prefixes.
- A match in `title`, `aliases` or `main` beats a match elsewhere.
- Filters: `#tag` or `tag:x`, `gestalt:name@1`, `-word`.
- An empty query lists every note by label. The storage port has no modification times, so there's no "recent" list.

Keys: `/` focuses the search. Use ↑/↓ and Enter to open a result, and Esc to leave the field.
