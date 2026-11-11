# Architecture

Personal plain-text data (one folder of ymls and blobs) with views on top. Wording: a **yml** is any file in the
folder; a **note** is a yml of gestalt `note`.

```
crates/merge      symmetric three-way merge of YAML values
crates/core       ymls, gestalts, the index and queries, sync, decks, blob GC; no IO
crates/fs         a folder on disk
crates/peer       another node over HTTP, a published deck, pairing
crates/wasm       the core in the browser
crates/device     a phone's folder and sync thread
crates/node       the local server, watcher, backends, LAN pairing
packages/view     @gestalts/view: everything a view gets from the app
packages/kit      @gestalts/kit: the UI kit views import (primitives < components < widgets < perspectives)
packages/learning @gestalts/learning: FSRS, practice sessions
packages/client   the wasm-backed repo; host side only
packages/host     frames, the bridge, tabs, installs
packages/vite     builds an app with its plugins and the frame runtime
plugins/          the note views
sdk/python        gestalts_backend.py, what a backend.py imports
```

`oxlint.config.ts` enforces who may import whom.

## Data

See [data-format.md](data-format.md). Every yml names exactly one gestalt and is judged by that definition alone.
Nothing is inferred from content, so a yml that doesn't say what it is, is invalid. Invalid ymls still sync byte for byte,
so nothing is ever destroyed, but they can't be queried; `gestalts-node health <dir>` lists them and says why.

## How data reaches a view

The host holds one index, built once on open and updated per changed id. A view never holds the index:

- `useQuery` is a **live query**, one bounded page at a time. It must name one gestalt.
- When ymls change, only subscriptions whose predicate matches an old or new version of one of them are recomputed, and
  each gets a delta of its page. `crates/core/src/repo.rs` has a test of this with 12k ymls.
- Search, ordering, a random draw and reverse references all run in the host's index.
- Opening still parses every yml once, in the host. A persisted snapshot could go behind the same contract.

Writes from anywhere end up the same way: the node's watcher sees the file change and the host reindexes those ids, so a
hand edit is no different from a write through the API.

## Views

A view is one React file, run in `<iframe sandbox="allow-scripts">`: an opaque origin, with no access to the app's DOM
or storage. Source views and vibecoded views run identically. Frames nested in it inherit the sandbox, so third-party
embeds (a YouTube player) stay blank there. For those, the distribution can grant a view that asks for it
(`frame: same-origin`) a frame with `allow-same-origin`: it then runs as part of the app. That is the exception, for
first-party views that load nothing at run time; see [plugins.md](plugins.md).

The frame loads nothing from the app's origin, because an opaque origin can't. The host sends everything over a
`MessagePort`: one script holding React, the kit and learning (built by `@gestalts/vite`), the styles, and the view's
compiled module. `packages/host/src/frame/boot.ts` turns those into `blob:` modules and an import map. Other npm packages
resolve through esm.sh.

Every call crosses `packages/host/src/frame/bridge.ts`, which checks it against the view's `reads` and `writes`, outside
the frame. A sandboxed frame isn't a secure context, so anything needing `crypto.subtle` is a call to the host.

`@gestalts/view` also has `fixtureHost`: a view runs against that with no app around it.

Recently used tabs stay alive hidden, fewer on a phone. A view unloaded from memory restores through `useViewState`.

## Plugins

See [plugins.md](plugins.md).

## Sync

Three phases over content hashes against a base, so a host can let its own writes go ahead while the network is busy:
fetch the remote's changes, merge locally, push. Merging one yml uses the merge rules of the gestalt it names. A value no
rule settles becomes a `conflict@1` yml on both sides. Deletes are tombstones. Decks are a read-only layer under the user's
folder and never sync.

Blobs are content-addressed and collected only after staying unreferenced for 7 days and 3 collections. Any invalid yml
pauses collection, since what's in use can't be known for sure.

## The node

`gestalts-node` serves a folder on 127.0.0.1 and runs plugin backends. A folder is marked in `.gestalts/format`; one
holding ymls without that marker is refused.

| Route | |
|---|---|
| `/health`, `/events` | who's here; a WebSocket of changed ids |
| `/ymls/{id}` | read, write, delete one (a backend's token is checked against its manifest) |
| `/sync/{hashes,read,write}` | what syncing apps use; hashes are cached by file time and size |
| `/blobs`, `/blobs/{name}`, `/blobs/collect` | |
| `/services/{plugin}/{path}` | a plugin's backend |
| `/net` | HTTP for a view, to hosts some plugin declares in `network` (the bridge checks the view's own list first) |
| `/llm/complete`, `/llm/settings` | completions from the user's providers in their order; keys are kept in the node's config folder and never returned |
| `/control/*` | the embedding app |

Paired devices reach a subset over TLS on the home network.
