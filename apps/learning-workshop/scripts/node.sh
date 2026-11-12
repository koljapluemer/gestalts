#!/usr/bin/env bash
# The node the workshop syncs with: gestalts-node from this repo, headless, with only this repo's plugins (the
# workshop agent backend), on its own port and profile so it runs beside the Gestalter's desktop app.
#   WORKSHOP_DATA       the folder (notes/ + blobs/), default ~/gestalt-workshop-views
#   WORKSHOP_NODE_PORT  default 7727 (the Gestalter's node is on 7717, and 7718 while pairing)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
data="${WORKSHOP_DATA:-$HOME/gestalt-workshop-views}"
port="${WORKSHOP_NODE_PORT:-7727}"
mkdir -p "$data"
# from the repo root, so rustup picks up its rust-toolchain.toml
cd "$here/../.."
exec cargo run -q -p gestalts-node -- --profile workshop --port "$port" --lan-port "$((port + 1))" \
  --plugins-dir "$here/plugins" serve --data "$data"
