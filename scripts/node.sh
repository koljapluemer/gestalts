#!/usr/bin/env bash
# folder-sync for development (`mise run node`, installables/folder-sync): gestalts-node headless with the repo's
# plugins and the dev profile, so it stays apart from an installed one. The web app's home areas ask it for plugin
# backends, /net and /llm, and may sync with it; its folder is the one remembered for the dev profile, if any.
#   GESTALTS_NODE_PORT    default 7727, and the one after it for the home network (clear of an installed node on 7717)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
port="${GESTALTS_NODE_PORT:-7727}"
# from the repo root, so rustup picks up its rust-toolchain.toml
cd "$root"
exec cargo run -q -p gestalts-node-desktop -- --profile dev --port "$port" --lan-port "$((port + 1))" \
  $(bash scripts/plugin-dirs.sh) serve
