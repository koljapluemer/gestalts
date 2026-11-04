# Next steps

What's built is in [architecture.md](architecture.md) and the docs it links. This file has where the project goes
from here: its shape, the repos, the steps to get there, and what's not built yet.

## The shape

The fundamental idea is the data: notes in plain YAML whose gestalts give them shape and merge rules, and the core
that reads, queries and syncs them. Applications for different real-world contexts are built on it:
- **Gestalter**: an Obsidian-like note app, on desktop, Android and later iOS, with the same UX on each.
- **loops-for-learning**, an educational web app: hosted, focused on learning, syncable with the user's notes.
- Later, other apps for other audiences, on the same data.

Dependencies point one way:

```
format + core  ←  platform (host, plugin contract, node, peer)  ←  plugins  ←  apps
```

## Repos

A repo isn't a package. Imports need released, versioned packages with clear boundaries, not a repo for each.

- **`gestalts`**: the foundation, one repo publishing many packages: the format and core, the platform and the
  plugins. Its interfaces still change, and nothing outside uses one part of it alone yet, so a host change and the
  plugin fixes it needs land in one commit. The lint keeps dependencies pointing down, so it can be cut apart along
  those lines later: when something outside needs only one part (an iOS or Python reader of the core, third-party
  plugins against a stable `host_api`).
- **`gestalter`**: `desktop/`, `android/`, later `ios/`, and the distribution they share. Its own steps (the
  desktop serving the Gestalter, Android) are in its `doc/next-steps.md`.
- **`loops-for-learning`**, the educational web app.
- **Later apps**, each a repo of its own.

An app is a distribution plus its shell, packaging and real-world specifics: installers, a hosted site or store
listings, with their own CI, signing keys and accounts, release pace and docs.

| contract | versioned by | checked by |
|---|---|---|
| notes on disk | the data format | the core |
| plugin ↔ host | `host_api` | the host, which refuses or greys a pane |
| plugin manifest | `schema` | the node and the host |
| worker ↔ node | the Python SDK and the node API | the node |
| device ↔ device | the node API version in `/health` | a peer, before it syncs |

Until the packages are published, the apps are checked out next to this repo and use it by path: pnpm `link:` for
the packages and plugins, Cargo `path` for the node. So the foundation and an app change together. Once published,
they pin versions, and `link:` overrides and Cargo `[patch]` do the same for local work.

### `gestalts`, once regrouped

```
crates/
  merge          symmetric 3-way merge of YAML values
  core fs wasm   as now
  peer           Storage over HTTP to another device's node, native and wasm (from wasm/http.rs)
  node           server, node API, pairing, worker host, plugin manifests (the Gestalter's desktop app embeds it)
gestalts/        the core's gestalt definitions
packages/
  sdk kit learning   the plugin contract (npm)
  client         the core in the host: a wasm backend (browser) and a native one (Tauri IPC)
  ui             the host: pane shell, capability frame, installs, conflict resolver
  vite           builds an app with its plugins
sdk/python       the worker contract (PyPI)
plugins/         every plugin, each an npm package
```

## Steps

One plan session each. Each ends with a visual check in the app and `doc/` updated.

- [x] **Split the repos**: this one, `gestalter` and `loops-for-learning` (fresh imports from `gestalts-legacy`,
  which keeps the earlier history). The connector is split into `node` here and the Gestalter's `desktop/` (tray,
  status, packaging, built-in plugins), with `gestalts-node` as the headless node, e.g. for a GPU box.
- [ ] **Regroup** the rest into the layout above: the `peer` crate, and `node` absorbing `plugin-host`.
- [x] **Plugins as npm packages**: `plugin.yml`, gestalts, deck, `ui/` and `worker/` in one package. Distributions
  pin them in `package.json`, and `distribution.yml` keeps only the panes. `@gestalts/vite` and the desktop app's
  build read plugins from `node_modules`; the desktop app embeds the workers of the plugins it ships.
- [ ] **The desktop app serves the Gestalter** (gestalter). Here: the node serves an app's build, and
  `packages/client` uses the folder through the node directly, with no OPFS layer.
- [ ] **Panes per distribution.** A pane declares what it needs (`requires: {services: [typst@1]}`), and the host
  hides or greys the ones it can't satisfy. `pane@1` notes get the distribution they belong to, so a phone doesn't get
  the desktop's tabs; each host shows and seeds only its own. Installs stay global.
- [ ] **[Cheaper sync](#cheaper-sync)**, before syncing over a network.
- [ ] **Pairing** a device with the desktop:
  - The node also listens on the home network, encrypted, and accepts only paired devices (this is the
    authentication the connector lacks).
  - The desktop shows a QR code with its address and key; the phone scans it, and finds the desktop again by mDNS
    when its address changes.
  - Each peer has its own base, as each connector URL and folder id has now.
- [ ] **Android** (gestalter). Here: `client`'s native backend (Tauri IPC) and the core with `FsStorage` on a phone.
- [ ] **Publish** `@gestalts/core` (wasm), `client`, `sdk`, `kit`, `learning` and the Python SDK. Every plugin's
  standalone build (`mise run check-plugin-standalone`) runs in CI.
- [ ] **Apps pin released versions** instead of linking a sibling checkout, with CI per repo.

### What pairing doesn't cover

A phone syncs only while the desktop is on and on the same network. The hosted educational web app reaches the
desktop node only from a browser on that same computer. The answer for both is cloud sync, later: "sign in with
Dropbox / Google Drive", the user's own cloud, as one more `Storage` in the core, so the desktop syncs with it too.
It needs cheaper sync (a cloud API is slow per file and rate-limited) and a guard against two devices writing at
once, or one's merge overwrites the other's. Dropbox has conditional writes; Drive probably needs a lock or a
manifest. Narrow permissions (Dropbox's app folder, Drive's `drive.file`) avoid Google's long verification.

## Ports

Each a plugin in `plugins/<id>/`. The gestalts they need: [integration-gestalts.md](integration-gestalts.md).
Generic note-taking features (Daily, Calendar, Projects, Graph…) are as much part of Gestalter as Explorer is.

From dsl:
- [x] Learn
- [ ] Daily and Calendar (day/range views, past-appointment cleanup)
- [ ] Projects, Goals, Tasks
- [ ] Desk, Explorations, Tags, Suggest
- [ ] Queue, Float, Questions (Ollama service)
- [ ] Graph
- [ ] Published and the site export
- [ ] Portfolio, card collages (`renders`, Chromium plugin), PDF export
- [ ] Viz blocks (`viz`, claude CLI plugin)
- [ ] Semantic search (Ollama embeddings), continuous `.bib` export to a path on disk (the Sources pane downloads one)

From sam-learns-things (each: catalog → deck, its Dexie tables → notes; the users' learning data isn't migrated):
- [x] quotes
- [ ] learn-flags, world-map
- [ ] top-vocab, dont-translate
- [ ] 20-words
- [ ] with-videos
- [ ] infinitesentences
- [ ] saetze, egyptiansentences
- [ ] hebrewscript, minimal-pairs-practice
- [ ] arabicnumbers, typingpractice
- [ ] currency-conversion-practice, triangle-congruence
- [ ] simplify-expressions
- [ ] tprboard
- [ ] al-kutshina

## Not built yet

### Cheaper sync

Each sync still reads every local, remote and base note, and Firefox OPFS is slow per file
([bug 2072928](https://bugzilla.mozilla.org/show_bug.cgi?id=2072928)). Next, guided by the step timings in the debug
log:
- track which keys changed locally since the last sync
- have the node list `{key: hash}`, so only differing notes are fetched
- keep a manifest of agreed hashes instead of a full base copy
- release the write queue during network time

If per-file OPFS cost still dominates: the core in a Worker with sync access handles, or notes stored in one OPFS
file.

### Workers

A worker is another client of the data, not part of a perspective. It reads notes and writes notes and blobs, and
the folder is how it talks to the UI:
- Batch work (fetch, OCR, LLM calls) runs on notes: an `interest-profile` note goes in, `news-item` notes come out; a
  `sketchbook-page` note with `status: queued` goes in, crops and proposals come out. Reviewing is editing notes, and
  committing is setting a status the worker acts on.
- The perspective only renders notes, so it works without the backend: offline, in the browser alone, on Android.
- Gestalts separate the keys the worker owns from the keys the user owns, or use separate notes, so the per-key
  merge rarely conflicts.
- Results are ordinary gestalts (`flashcard@1` rather than an Anki deck), so other perspectives can use them.

Workers run where there's a node. Elsewhere, the UI part works on whatever notes have synced. Start by porting one
heavy backend by hand (e.g. `../news` or `../language-sketchbook-to-anki`), and extract more of the contract once
there are two.

Not built:
- schedule triggers (parsed, never run)
- a worker on another machine registering with the node by URL
- change notifications: the node has no watch/SSE endpoint, and 15 s sync is slow for progress updates
- volume: `Repo` loads every note, so high-volume workers need retention or digest notes
- Python validating gestalts: `mise run lint-data` for now, maybe a pyo3 binding of the core later
- secrets live with the worker, never in notes

### Plugins from elsewhere

| tier | from | runs |
|---|---|---|
| built-in | an app's distribution | in-process, through the same scoped port as any plugin |
| local | `plugins/` in the data folder, or a perspective note | sandboxed by default, or in-process if marked trusted |
| third-party | a URL or registry | sandboxed; installing shows `access`; a worker needs approval |

Only built-in plugins exist so far. First-party code already uses the scoped port, so moving a plugin into a sandbox
is a deployment change. A worker is native code with full access to the machine: `access` limits what it can do to
notes, nothing else. Workers you wrote yourself are trusted when they're dropped into `plugins/`; third-party ones
need an explicit approval or a container runtime.

- An iframe host for panes: `sandbox="allow-scripts"`, the perspective port over `postMessage`, blob URLs, host
  capabilities shown outside the frame.
- Slots in iframes, one frame rendering a whole list (not one frame per canvas node).
- `perspective@1` notes: a perspective's source in a note, compiled in the browser (sucrase or esbuild-wasm), for
  vibe-coding in the app; "promote to plugin"; each device asks before running one whose `access` widened.
- Third-party plugins from a URL or registry, with the access shown on install and namespaced gestalts
  (`<publisher>/<name>@N`).

### Other

- Obsidian two-way sync: likely a converter between Markdown with frontmatter and notes, plus the existing sync.
- A browser extension (e.g. vocabulary from Duolingo), writing through the node API.
- Modification times in the `Storage` port, which the search needs for a "recent" list.
- Canvas2Typ shows the canvas through a slot, which takes only the note: add notes to it from the Canvas pane. A
  slot with an "add" input would bring that back.
- Changing installs takes a reload (decks mount when the repo opens).
- Undo for more than the last canvas removal; text ↔ note conversions aren't undoable yet.
- Learner activity and time statistics: `practice-session@1` notes record trials and active time, but no page shows
  them yet.
- Decks, beyond [copy-on-write](architecture.md#copy-on-write-from-a-deck):
  - a "download the whole deck" action that copies everything up front, for offline use or archiving
  - a 3-way merge for diverged copies; it needs the deck text as copied, so either keep old deck releases or store a
    base snapshot next to the copies
  - a deck-subscription note in user space (source URL, revision, words the user dismissed), so the folder records
    where the rest of the deck comes from
  - a UI for `upstreamReport()` ("3 words updated")
- Purging a blob everywhere at once, for privacy.
- FSRS state computed from the review log instead of `newest_by`: today two offline reviews of one card keep only
  the later one, and `newest_by` trusts device clocks.
