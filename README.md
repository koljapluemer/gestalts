# gestalts

Shared code base, idea and paradigm for gestalt-based apps: personal plain-text data (YAML notes + blobs in one
folder) with interchangeable views on top. The core, the node, the host, the plugin contract and every plugin live
here; the apps (`gestalter`, `loops-for-learning`) are repos of their own.
See [`doc/`](doc/) — start with [`doc/architecture.md`](doc/architecture.md); the original idea is in
[`doc/initial_spec.md`](doc/initial_spec.md).

## Developing

Needs [mise](https://mise.jdx.dev) and [rustup](https://rustup.rs). mise installs Node, pnpm, uv and wasm-pack as
pinned in `mise.toml`; rustup picks up the Rust version from `rust-toolchain.toml`.

```sh
mise install          # once after cloning, and when mise.toml changes
mise run setup        # JS dependencies and the core in wasm; the apps' setup runs this too
mise run check        # tests, lints, typechecks
mise run check-plugin-standalone quotes          # build a plugin outside the workspace, as in its own repo
mise run publish-data plugins/<id>/decks/<deck>     # after editing a plugin's deck
mise run serve ~/some-folder                      # the node headless with this repo's plugins
mise tasks            # everything else
```

To see changes in an app, check it out next to this repo and run it there (`mise run dev`): it links these packages,
plugins and crates by path, so they hot-reload.

```
parent/
  gestalts/
  gestalter/
  loops-for-learning/
```
