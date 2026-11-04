# The node and sync

The node (`crates/node`) makes a folder on this computer the source of truth for the web apps, and runs their
plugins' workers. Apps embed it: the Gestalter's desktop app (the "connector", in the gestalter repo) adds a tray, a
status window, its built-in plugins and its own frontends' origins. `gestalts-node` is the node alone, e.g. for a GPU
box:

```sh
gestalts-node serve [--data DIR] # the folder from --data, else the remembered one
gestalts-node lint DIR           # gestalts and lints per note
gestalts-node publish DIR        # prepare a folder as a read-only deck
# all of them: [--port 7717] [--profile NAME] [--plugins-dir DIR]... [--allow-origin URL]...
```

`mise run serve DIR`, `lint-data` and `publish-data` run it with this repo's `plugins/`. The `dev` profile keeps its
settings apart from an installed app. All use port 7717, so quit one before starting another.

## Folders

A data folder holds `notes/`, `blobs/` and `.gestalts/folder-id`, a UUID created when the folder is first opened.
`/health` reports `folder: {id, path}`, or `null` while none is chosen; until then `/notes*` and `/blobs*` answer
`409`. The web apps keep their sync base per connector URL *and* folder id. Switching folders behind the same URL
therefore can't make one folder's missing notes look like deletions in another.

## Where it keeps its files

All per user, through the OS's standard locations (XDG on Linux, Application Support on macOS, AppData on Windows),
under `gestalts` (or `gestalts-<profile>`):

| | |
|---|---|
| config | `config.json` (`folder`, `extra_origins`), `control-token` |
| data | `builtin-plugins/<hash>/` (unpacked from the binary), `plugins/` (your own), `uv/`, `python/` |
| cache | `plugins/<id>/venv`, uv's download cache |

## Plugins

A plugin (`plugins/<id>/plugin.yml`, schema 2; see [architecture.md](architecture.md#plugins)) may have a worker.
The node hosts those workers, and loads every plugin's gestalts for its lints, triggers and access checks. An app
may pass built-in plugins (`Embedded`): their manifests, gestalts and workers, plus the Python SDK (not their UI or
decks), compiled into its binary and unpacked on start under the layout of this repo (`plugins/<id>/`,
`sdk/python/`). `gestalts-node` has none. Plugins you add go in the data folder's `plugins/`. `--plugins-dir`
replaces both, which is useful when developing plugins.

Workers are Python projects run in locked uv environments: `uv sync --locked`, then the environment's own executable,
which gets scoped, process-lifetime credentials. The node uses `GESTALTS_UV`, else a uv ≥ 0.9 on `PATH`, else it
downloads a pinned uv release (checksum-verified) into its data folder. uv in turn fetches Python if none is installed,
so users install nothing.

`GET /plugins` reports worker health, `POST /plugins/{id}/runs` starts a manual run, `GET /services` discovers
services, and `/services/{id}/…` proxies them (with the query string and `Content-Type`; a service gets 30 s before the
app sees a 504). A worker whose process has ended is restarted on the next run or service request, and its error
says so meanwhile.

Plugins with workers:
- `conformance`: exercises the plugin contract. Not built in; use it with `--plugins-dir plugins`.
- `typst` (built into the Gestalter): the `typst@1` service. `POST /services/typst@1/compile` with `{source, assets?: {path: blob}, bib?, format:
  "svg" | "pdf"}` compiles in a fresh folder (assets at their paths, `bib` as `/sources.bib`, system fonts ignored)
  and answers SVG pages as JSON, the PDF, or 422 `{diagnostics, missing}`. It reads `typst-document@1` notes and the
  blobs they reference, and writes nothing.

## Access

The node listens on `127.0.0.1` only. CORS allows `http(s)://localhost:*` and `127.0.0.1:*`, the embedding app's
own frontends (the Gestalter's: `https://gestalter.koljasam.com`), `extra_origins` from the config, and any
`--allow-origin`. The notes API
has no authentication: anything on this machine with an allowed origin can read and write the folder.

`/control/*` (status, choose folder, show window, quit) is only for the embedding app's own window. It needs the per-run
token from `control-token` in the `x-gestalts-control` header, and rejects any request that carries an `Origin`, which
is every request a web page can make.

| endpoint | |
|---|---|
| `GET /health` | `{app, version, folder: {id, path} \| null}` |
| `GET /notes` | `[{key, text}]` — all notes |
| `GET/PUT/DELETE /notes/{key}` | raw YAML text; `DELETE` writes the note's tombstone |
| `GET /blobs` | names |
| `GET/PUT/DELETE /blobs/{name}` | bytes; workers can't delete |
| `POST /blobs/collect` | collects unreferenced blobs (above): `{deleted}` |
| `GET /control/status`, `POST /control/folder {path}`, `POST /control/show`, `POST /control/quit` | the app's own window only (see above) |

## Sync

The apps sync their writable OPFS notes with the folder at these times:
- on connect
- 0.8 s after each write
- every 15 s

At most one sync runs, and at most one more waits (`coalesce`, `packages/client/src/coalesce.ts`): requests while one is already waiting join it. Syncs and writes share one queue, so piled-up syncs would make every write wait. After a sync only the notes it wrote locally (pulled, conflict notes, upstream copies) are re-read into the index. The debug log's `sync done` lists the note counts and how long each step took.

Each side is compared with a **base**: the state after the last sync, stored in OPFS per connector URL and folder id.
Each note is then merged by `merge_note` (`crates/core/src/merge.rs`) with the engine in `crates/merge`, which is
symmetric: two devices merging the same states get the same result, whichever is local.

- Only one side changed since the base: take that side.
- A note missing on one side while the base has it was removed by hand: that counts as a delete (a tombstone).
- A delete against a concurrent edit: the delete wins, and the edit is kept as a conflict, so it can be restored.
  Writing a note over its tombstone brings it back.
- Both sides changed: merged by the note's policy. The default: `tags`, `relationships` and `blobs` as sets (an item
  either side added is kept, one either side removed is dropped); `main`, `extra` and `tasks` line by line; every
  other key per key, recursing. Gestalts add their own rules ([gestalts.md](gestalts.md#merge)), e.g. the later
  review of a card wins as a whole.
- A value both changed differently that no rule settles, or a note that doesn't parse as a map: the side whose value
  sorts greater is kept, and the conflict is recorded as a `conflict@1` note on both sides
  ([gestalts.md](gestalts.md#conflicts)). The note editor and the connector settings list them: keep a side, or edit.

Blobs are content-addressed, so they're never merged. A blob goes to the side that lacks it only if a merged note
uses it. After each successful sync, the app collects its own unreferenced blobs and asks the connector to collect
the folder's (`POST /blobs/collect`). A blob is deleted only after it stayed unreferenced for 7 days and 3
collections; the manifest of when each was first seen unreferenced is `.gestalts/blob-gc.json` in the folder (OPFS
`<dir>-blob-gc` in the browser). "Referenced" means listed in `blobs` by a note that isn't a tombstone, or held by a
conflict record; deck blobs are never collected.

Caveats:
- The educational app (loops-for-learning) pulls every note in the folder, and the blobs they use, into its OPFS layer. Of the shipped words, only those the learner rated (and their blobs) are in that layer, so only those reach the folder.
- That app hosted on a public origin that calls `localhost` runs into Chrome's Private Network Access rules. The node does answer the preflight, but the prototype is only tested on local origins.
