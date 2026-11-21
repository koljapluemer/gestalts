# thia

Views on top-of semantic yml to represent a wide range of interactive learning experiences.

```
crates/       the core (Rust, also in the page as wasm), merge, fs, peer sync, the node, the phone's device
packages/     what apps and views build with: client, host, view (the view contract), kit, learning, sources, vite, viz
gestalts/     gestalt definitions: the core's, and model packages (gestalts/<package>/<name>/)
plugins/      the views (and their decks, workers), one folder each, usable by any app
sdk/python/   what plugin workers import
apps/
  web/                  the one web app: notes, learning, visualizations, the workshops, lessons; data in the browser
  player/               the lesson player, on the lesson domain
  gestalter/            the Android page (distribution-android/)
  learning-workshop/    the learning workshop's agent stats, tests and docs
  vizint-workshop/      the viz agent (plugins/), its template, tests and docs
  teacher/              the teacher server's worker and docs
  node/                 gestalts-node, optional beside the app: desktop/ (tray), settings/ (its page), android/
scripts/      shared by the tasks
```

from `plugins/` and their models from `gestalts/`, by `scripts/check-distributions.ts`. Both run in `mise run check`.

## Developing

Needs [mise](https://mise.jdx.dev) and [rustup](https://rustup.rs). mise installs Node, pnpm, uv, wasm-pack and the
packaging tools as pinned in `mise.toml`; rustup picks up the Rust version (and the wasm and Android targets) from
`rust-toolchain.toml`.

```sh
mise run just setup   # a new machine: the pinned tools and Rust, dependencies, the core in wasm, a local teacher
                      # account; again after pulling
mise run just dev     # the web app, the node and the teacher server with hot reload, beside an installed node:
                      # where each is, their output in target/dev/<name>.log
```

The rest is hidden from `mise tasks` (`mise tasks --hidden` lists it), for one-offs and agents:

```sh
mise run check                                    # tests, lints, typechecks, deck health
mise run web:dev                                  # the web app alone, hot reload
mise run node                                     # the node alone: the agents, plugin backends, the drafts
mise run node:dev                                 # the desktop node and its settings page, hot reload
mise run android:dev                              # the Android app on a phone or emulator (needs the SDK and NDK)
mise run publish-data plugins/<id>/decks/<deck>   # after editing a plugin's deck
mise run health-data ~/some-folder                # which ymls can't be used, and why
mise run serve ~/some-folder                      # the node headless with the repo's plugins
mise run teacher:deploy                           # the teacher app to its box (deploy/teacher/README.md)
```
