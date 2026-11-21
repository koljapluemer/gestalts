# gestalts-node on the desktop (folder-sync)

`gestalts-node` (`installables/folder-sync/desktop`) makes a folder on this computer the source of truth for the gestalts apps,
syncs it with paired devices and runs the plugins' workers, inside a tray. It ships no app: gestalter,
loops-for-learning and the learning workshop are websites that use it on `http://127.0.0.1:7717`. Install it from a
package (`mise run node:package` / `mise run node:install`) and launch it from the app menu. On first start it opens
its settings page, which asks for your folder; it remembers it and lives in the tray from then on.

The server, folders, change events, sync, plugins, workers and access are the node's (`crates/node`, see
[system overview](../../../doc/architecture/system-overview.md#the-node)).

```sh
gestalts-node                    # the desktop app: tray, opens its settings; one instance per user
gestalts-node --background       # same, without opening them ("Start on login" uses this; opens them anyway with no folder)
gestalts-node serve [--data DIR] # headless; the folder from --data, else the remembered one
gestalts-node health DIR         # every yml that can't be used, and why
gestalts-node publish DIR        # prepare a folder as a read-only deck
# all of them: [--port 7717] [--profile NAME] [--plugins-dir DIR]... [--models-dir DIR]... [--allow-origin URL]... [--app-dir DIR]
```

In development, `mise run node:dev` starts it with `--profile dev --plugins-dir plugins --models-dir gestalts` next to
the settings page's Vite server (from :5176), which proxies the node's API so the page is the node's own as when served
by it. The dev profile keeps its settings apart from an installed app, and the dev node stays clear of the installed
one's 7717.
`mise run just dev` (`scripts/dev.sh`) starts the web app, this node headless (`scripts/node.sh`, :7727: the repo's
plugins), the Claude bridge (`installables/claude-bridge`, :7737: the agents) and the teacher server, each on the first free port from its usual one, and prints where they are. The
web app doesn't need a node: its notes are in the browser.

## The apps on it

An app is a website: it reaches the node across origins (CORS, and Chrome asks once whether the page may use apps on
this device). Allowed are localhost (any port), the origins in `ORIGINS` (`installables/folder-sync/desktop/src/main.rs`: the
deployed gestalter and loops-for-learning) and the config's `extra_origins`. gestalter uses the folder directly
(`usePluginRepo({ node })`): every write goes to the folder, and the node's `/events` socket brings changes from
elsewhere (workers, another app, a hand edit) into the open page. loops-for-learning and the learning workshop keep
their ymls in the browser and sync with a node.

## Tray and settings

- **Tray:** shows the folder and has "Open settings" (also a left click), "Choose folder…" and "Quit". On Linux the
  tray is a StatusNotifierItem over D-Bus, so there's no GTK dependency. Desktops without a tray (e.g. GNOME without
  an extension) still get the settings: launching the app again opens them.
- **Settings** (`installables/folder-sync/settings`, served at `/`): the folder (choose another, show it in the file manager), uv and
  each plugin worker's state, devices (pair one by QR code, the paired ones with when they were last seen, forget
  one), the apps connected in the last minute, the LLM providers, "Start on login" and "Quit". They use the node's
  `/control/*`, which only the page the node serves (or the tray, with its token) may use; the native parts (picker,
  file manager, autostart) are the tray process's `Shell` (`installables/folder-sync/desktop/src/tray.rs`). Apps link to the page.
- **One instance:** launching it again while it runs opens the settings in the running one, then exits.

## What it brings along

- **The settings page:** `installables/folder-sync/settings/dist`, embedded by `installables/folder-sync/desktop/build.rs`
  (`mise run node:settings-build`). Without it the binary serves a page saying so.
- **The repo's plugins:** of every plugin in `plugins/`, `build.rs` copies the manifest, gestalts and `backend.py`
  (views and decks are in the apps' own builds), so the node knows every gestalt the apps write and runs their
  workers. The binary unpacks them on start.

## From `gestalter` and `gestalts-connector`

The app was called `gestalts-connector`, then `gestalter`. Its settings (the folder, `extra_origins`, LLM providers,
paired devices) are the node's and stay. "Start on login" moves to the new name on first start. The `.rpm` obsoletes
both old packages; the `.deb` can't say so, so remove `gestalter` by hand. If an old app still runs, the new one says
so and exits. gestalter is now a website on the node instead of built into it.

## Packaging

`mise run node:package` builds this OS's installers into `target/packages` (Linux: `.deb`, `.rpm`, AppImage; macOS:
`.dmg`; Windows: setup `.exe`) with cargo-packager and cargo-generate-rpm (the `[package.metadata.*]` sections of
`installables/folder-sync/desktop/Cargo.toml`). `mise run node:install` installs one here like a user would
(`scripts/install-package.sh`). The installed app needs nothing else: it brings the plugins' workers and downloads uv
(and through it Python) for them when needed.
