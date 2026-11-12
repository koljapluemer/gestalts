#!/usr/bin/env bash
# The node the vizint workshop syncs with: gestalts-node from this repo, headless, with the vizint plugin (its gestalt)
# and the workshop's agent backend, on its own port and profile so it runs beside other nodes.
#   VIZINT_WORKSHOP_DATA       the folder (notes/ + blobs/), default ~/vizint-workshop-data
#   VIZINT_WORKSHOP_NODE_PORT  default 7747
# Chromium for the agent's browser check is installed once, through uv.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"
data="${VIZINT_WORKSHOP_DATA:-$HOME/vizint-workshop-data}"
port="${VIZINT_WORKSHOP_NODE_PORT:-7747}"
mkdir -p "$data"
uv run --quiet --with playwright==1.65.0 playwright install chromium
# from the repo root, so rustup picks up its rust-toolchain.toml
cd "$root"
exec cargo run -q -p gestalts-node-desktop -- --profile vizint-workshop --port "$port" --lan-port "$((port + 1))" \
  --plugins-dir "$root/plugins" --plugins-dir "$here/plugins" serve --data "$data"
