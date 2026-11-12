# gestalts

Shared code base for gestalt-based apps: personal plain-text data (ymls and blobs in one folder, each yml naming exactly
one gestalt) with views on top. The core, the node, the host, the view contract and the note views live here; the apps
(`gestalter` and `loops-for-learning`, whose Make mode contains the former Workshop) are repos of their own. Start with
[`doc/architecture.md`](doc/architecture.md).

## Developing

Needs [mise](https://mise.jdx.dev) and [rustup](https://rustup.rs). mise installs Node, pnpm, uv and wasm-pack as
pinned in `mise.toml`; rustup picks up the Rust version from `rust-toolchain.toml`.

```sh
mise install          # once after cloning, and when mise.toml changes
mise run setup        # JS dependencies and the core in wasm; the apps' setup runs this too
mise run check        # tests, lints, typechecks
mise run publish-data plugins/<id>/decks/<deck>   # after editing a plugin's deck
mise run health-data ~/some-folder                # which ymls can't be used, and why
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
