#!/usr/bin/env bash
# Runs the agent template's check.ts (without the browser) on each of @gestalts/viz's examples, in a workspace laid out
# as the agent's: typecheck, the examples' checks, the build.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/vizint-example-XXXX")"
trap 'rm -rf "$tmp"' EXIT
for ex in "$root"/packages/viz/examples/*/; do
  id="$(basename "$ex")"
  ws="$tmp/$id"
  mkdir -p "$ws"
  cp -r "$ex"/. "$ws/"
  rm -rf "$ws/dist"
  cp "$here"/agent-template/{CLAUDE.md,check.ts,check.py} "$ws/"
  echo "example $id:"
  (cd "$ws" && VIZ_PACKAGE="$root/packages/viz" node check.ts --no-browser | grep -v '^ok ')
done
