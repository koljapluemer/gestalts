# The node and sync

The node (`crates/node`) makes a folder on this computer the source of truth for the web apps, and runs their
plugins' workers. Apps embed it: the Gestalter's desktop app (`gestalter`, in the gestalter repo) adds a tray, its
built-in plugins and its web build, which the node serves at `/`. `gestalts-node` is the node alone, e.g. for a GPU
box:

```sh
gestalts-node serve [--data DIR] # the folder from --data, else the remembered one
gestalts-node lint DIR           # gestalts and lints per note
gestalts-node publish DIR        # prepare a folder as a read-only deck
# all of them: [--port 7717] [--lan-port 7718] [--profile NAME] [--plugins-dir DIR]... [--allow-origin URL]... [--app-dir DIR]
```

`mise run serve DIR`, `lint-data` and `publish-data` run it with this repo's `plugins/`. The `dev` profile keeps its
settings apart from an installed app. All use port 7717, so quit one before starting another.

## Serving an app

An app's web build is served at `/`: the embedding app's own (`Embedded::app`), or `--app-dir DIR` (e.g. a `dist/`
from disk). `index.html` is `no-cache`, hashed `assets/*` are immutable, anything missing is a 404 (the apps route by
query string only). The API stays at the root beside it.

A page served this way uses the folder directly (`{ node: location.origin }` in `@gestalts/client`): the core runs
over `Peer` to the node, so every write lands in the folder, nothing is copied into OPFS, and nothing syncs. Its
copy-on-write from decks writes into the folder. `/events` keeps its index current.

## Change events

`GET /events` is a WebSocket. The node watches the open folder's `notes/` and `blobs/` (`crates/node/src/watch.rs`,
the `notify` crate), so changes from anywhere (the API, a worker, a hand edit, a file sync tool) go out, debounced
(100 ms, at most 1 s), as JSON:

| message | |
|---|---|
| `{"changed": {"notes": [keys], "blobs": [names]}}` | written or removed; the page rereads just these |
| `{"folder": {id, path} \| null}` | another folder is open: the page reloads |
| `"reload"` | this client fell behind: reread everything |

A WebSocket, not server-sent events, since browsers allow only six HTTP/1.1 connections per host and every open tab
would hold one. A page that loses the socket shows that the desktop app isn't running, reconnects, and rereads
everything once it's back.

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
| config | `config.json` (`folder`, `extra_origins`), `control-token`, `node.crt` and `node.key` (its TLS key, which is its id), `devices.json` (paired devices) |
| data | `builtin-plugins/<hash>/` (unpacked from the binary), `plugins/` (your own), `uv/`, `python/` |
| cache | `plugins/<id>/venv`, uv's download cache |

The desktop app's rename (from `gestalts-connector` to `gestalter`) didn't move these: they're the node's.

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

The node listens on `127.0.0.1`, and there it answers only requests whose `Host` is `localhost`, `127.0.0.1` or `[::1]`,
so a page on another domain that resolves to 127.0.0.1 (DNS rebinding) can't pass as same-origin. CORS allows
`http(s)://localhost:*` and `127.0.0.1:*`, the origins the embedding app lists (`Embedded::origins`), `extra_origins`
from the config, and any `--allow-origin`; `/events` checks the same list itself, since CORS doesn't cover
WebSockets. The notes API has no authentication: anything on this machine with an allowed origin can read and write
the folder.

`/control/*` is for the embedding app: its own process (the tray) with the per-run token from `control-token` in the
`x-gestalts-control` header, or the web frontend it serves, recognized as same-origin (`Origin` equal to the request's
host, or, for a GET, `Sec-Fetch-Site: same-origin`). Any other request with an `Origin`, which is every request
another web page can make, is refused.

What `/control/*` does natively (the folder picker, the file manager, start on login, quit) is the embedding app's
`Shell` (`server.rs`); the headless node's does none of it.

On the home network it answers only paired devices (below).

| endpoint | |
|---|---|
| `GET /health` | `{app, version, api, folder: {id, path} \| null}`; `api` is the node API's version (2: `/sync/*`) |
| `GET /notes` | `[{key, text}]` — all notes |
| `GET/PUT/DELETE /notes/{key}` | raw YAML text; `DELETE` writes the note's tombstone |
| `GET /sync/hashes` | `{key: hash}` — every note's SHA-256 (hex) |
| `POST /sync/read {keys}` | `[{key, text}]` — those of the notes that exist |
| `POST /sync/write [{key, text}]` | writes them all |
| `GET /blobs` | names |
| `GET/PUT/DELETE /blobs/{name}` | bytes; workers can't delete |
| `POST /blobs/collect` | collects unreferenced blobs (above): `{deleted}` |
| `GET /events` | WebSocket of change events (above) |
| `GET /control/status` | folder, connected web apps, uv and plugins, `autostart` (null if unavailable) |
| `POST /control/folder {path}`, `POST /control/choose-folder` | open a folder, given or picked natively; the status |
| `POST /control/reveal`, `PUT /control/autostart {on}`, `POST /control/show`, `POST /control/quit` | the app's shell |
| `POST /control/pairing`, `DELETE /control/pairing` | open a pairing offer (`{uri, svg, addresses, expires_in}`), or close it |
| `GET /control/devices`, `DELETE /control/devices/{id}` | the paired devices; unpair one |
| anything else | the app's web build, if it has one |

## Sync

Apps whose notes are in OPFS (loops-for-learning, or any page not served by the node) sync them with the folder at
these times:
- on connect
- 0.8 s after each write
- every 15 s

At most one sync runs, and at most one more waits (`coalesce`, `packages/client/src/coalesce.ts`): requests while one is already waiting join it. After a sync only the notes it wrote locally (pulled, conflict notes, upstream copies) are re-read into the index. The debug log's `sync done` lists the note counts, how many notes differed (`compared`), and how long each step took.

Each side is compared with a **base**: the state after the last sync, stored in OPFS per connector URL and folder id
(a paired device keeps one per node and folder, `gestalts_peer::paired::base_name`).

A sync reads only what changed (`crates/core/src/sync.rs`):
- Each side lists `{key: hash}`. The node hashes its folder (`/sync/hashes`); the browser keeps the hashes of its
  OPFS notes in memory (`Tracked`), learned when the repo opens (which reads every note anyway) and kept current by
  every write.
- The base keeps the hashes it agreed on in a manifest (the blob `manifest.json` next to its notes). A base from
  before manifests gets one on its next sync.
- Only notes whose three hashes differ are read: the remote ones in one request (`/sync/read`), a base text only
  where both sides changed. Pushes go in one request too (`/sync/write`). A sync where nothing changed reads no
  note, only the remote hashes and the manifest.
- Each note the sync merges is read anew, so a hash gone stale (another tab wrote the note) never makes it write
  over a change it hasn't seen; it only delays that note to a later sync.

It runs in three phases, and only the middle one waits in the app's write queue, so the app's writes don't wait for
the network:
1. fetch, network only: the remote hashes, the remote texts that changed since the base, the blobs those use that
   this side lacks
2. merge, local only: merges, writes this side, moves the base for notes the remote already has
3. push, network only: the blobs the pushed notes use, the notes, then the base

The base moves only once both sides hold a text. A sync that fails halfway is redone by the next: the merge is
symmetric, so it gives the same result again.

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

Blobs are content-addressed, so they're never merged. A blob goes to the side that lacks it only if a note going
there uses it, and before that note. After each successful sync, the app collects its own unreferenced blobs and asks the connector to collect
the folder's (`POST /blobs/collect`); a page on the folder directly asks once after opening. A blob is deleted only after it stayed unreferenced for 7 days and 3
collections; the manifest of when each was first seen unreferenced is `.gestalts/blob-gc.json` in the folder (OPFS
`<dir>-blob-gc` in the browser). "Referenced" means listed in `blobs` by a note that isn't a tombstone, or held by a
conflict record; deck blobs are never collected.

## Pairing and the home network

Devices (a phone, a laptop) reach the node over the home network once paired with it. A browser can't, since it can't
trust the node's own certificate: this is for apps with native networking (`gestalts_peer::paired`).

- **The node's key.** On first start the node makes a self-signed TLS certificate and key (`node.crt`, `node.key`).
  The certificate's SHA-256 is the node's id. Devices pin it, so no certificate authority is involved.
- **Pairing.** The desktop's settings show a QR code (`POST /control/pairing`) holding
  `gestalts-pair:?v=1&id=<fingerprint>&addr=<ip:port>,…&secret=<one-time secret>&name=<computer>`. It is valid for
  five minutes, for one device. The device connects to an address over TLS, accepting only the certificate with
  that fingerprint, and sends the secret to `POST /pair {secret, name}`. It gets back a token (`{token, device_id,
  node_id}`) and keeps it with the addresses (`PairedNode`). The node keeps only the token's hash in `devices.json`.
  Pairing attempts are limited to five a minute.
- **Afterwards** every request carries `Authorization: Bearer <token>`. Forgetting a device in the settings
  (`DELETE /control/devices/{id}`) ends its access at once.
- **Finding it again.** The node advertises `_gestalts._tcp` by mDNS, with its id in the TXT record `id`. A device
  tries the address that worked last, then the others, then whatever mDNS finds (`paired::connect`). On Android, the
  app must hold a `MulticastLock` while discovering.
- **When it listens.** Only while a pairing code is shown or a device is paired: on `--lan-port` (7718) on every
  interface. Addresses on container and VM bridges (`docker0`, `br-…`, `virbr…`) aren't offered or advertised.
- **What it serves there.** `GET /health` (`{app, version, api, node_id, folder}`) and `POST /pair` without a token.
  With one, `/notes*`, `/sync/*` and `/blobs*`. Nothing else: not `/control`, `/events`, plugins, services or the
  app's frontend. A paired device syncs like a browser does, with the node's folder, polling (no change events over
  the network yet).

Caveats:
- The educational app (loops-for-learning) pulls every note in the folder, and the blobs they use, into its OPFS layer. Of the shipped words, only those the learner rated (and their blobs) are in that layer, so only those reach the folder.
- That app hosted on a public origin that calls `localhost` runs into Chrome's Private Network Access (now Local
  Network Access, which asks the user for permission) rules. The node does answer the preflight, but this is only
  tested on local origins. The Gestalter avoids it by being served by the node.
