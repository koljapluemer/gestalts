#!/usr/bin/env bash
# The local Make node and the Loops app, stopped together.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
"$here/scripts/node.sh" &
node_pid=$!
trap 'kill "$node_pid" 2>/dev/null || true' EXIT INT TERM
cd "$here"
pnpm dev
