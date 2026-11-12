# gestalts

Personal plain-text data (ymls and blobs in one folder, each yml naming exactly one gestalt) with views on top, and the
apps built on it. Start with [`doc/architecture.md`](doc/architecture.md).

```
crates/       the core (Rust, also in the page as wasm), merge, fs, peer sync, the node, the phone's device
packages/     what apps and views build with: client, host, view (the view contract), kit, learning, sources, vite
gestalts/     the core's gestalt definitions
plugins/      the views (and their decks, workers), one folder each, usable by any app
sdk/python/   what plugin workers import
apps/
  gestalter/            notes and learning, a website on the node: distribution/, distribution-android/
  loops-for-learning/   the learning views, one at a time: a static site
  learning-workshop/    make learning views with a local agent
  node/                 gestalts-node, keeping your ymls: desktop/ (tray), settings/ (its page), android/, iOS later
scripts/      shared by the tasks
```

Who may import whom (packages, plugins, apps) is checked by `oxlint.config.ts`; that apps take their plugins only
from `plugins/`, by `scripts/check-distributions.ts`. Both run in `mise run check`.

## Developing

Needs [mise](https://mise.jdx.dev) and [rustup](https://rustup.rs). mise installs Node, pnpm, uv, wasm-pack and the
packaging tools as pinned in `mise.toml`; rustup picks up the Rust version (and the wasm and Android targets) from
`rust-toolchain.toml`.

```sh
mise install          # once after cloning, and when mise.toml changes
mise run setup        # JS dependencies, the core in wasm, the Make agent template
mise run check        # tests, lints, typechecks, deck health
mise run dev                                      # all of the below at once, beside an installed node
mise run gestalter:dev                            # gestalter on a dev node, hot reload
mise run node:dev                                 # the desktop node and its settings page, hot reload
mise run loops:dev                                # loops-for-learning
mise run workshop:dev                             # the learning workshop and its local Make node
mise run android:dev                              # the Android app on a phone or emulator (needs the SDK and NDK)
mise run publish-data plugins/<id>/decks/<deck>   # after editing a plugin's deck
mise run health-data ~/some-folder                # which ymls can't be used, and why
mise run serve ~/some-folder                      # the node headless with the repo's plugins
mise tasks            # everything else
```

## History

Until 2026-11-12 the apps and plugins were repos of their own, now archived: gestalter (`f64751c`), gestalt-plugins
(`f642f41`), loops-for-learning (`0ba0ff7`, which had folded in gestalt-workshop). Each has a `pre-one-gestalt` tag
from before the one-yml-one-gestalt re-architecture.
