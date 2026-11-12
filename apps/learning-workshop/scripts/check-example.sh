#!/usr/bin/env bash
# Runs the agent template's check.ts on each example, in a workspace laid out as the worker lays one out.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/workshop-example-XXXX")"
trap 'rm -rf "$tmp"' EXIT
for ex in "$here"/agent-template/examples/*/; do
  id="$(basename "$ex")"
  ws="$tmp/$id"
  mkdir -p "$ws"
  cp "$here"/agent-template/{tsconfig.json,check.ts} "$ws/"
  ln -s "$here/agent-template/node_modules" "$ws/node_modules"
  cp -r "$ex"/. "$ws/"
  echo "example $id:"
  (cd "$ws" && node check.ts)
done
