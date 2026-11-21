#!/usr/bin/env bash
# Runs the agent template's check.ts on each example, in a workspace laid out as the worker lays one out.
set -euo pipefail
template="$(cd "$(dirname "$0")/../../../../packages/workshop/agent-template" && pwd)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/workshop-example-XXXX")"
trap 'rm -rf "$tmp"' EXIT
for ex in "$template"/examples/*/; do
  id="$(basename "$ex")"
  ws="$tmp/$id"
  mkdir -p "$ws"
  cp "$template"/{tsconfig.json,check.ts} "$ws/"
  ln -s "$template/node_modules" "$ws/node_modules"
  cp -r "$ex"/. "$ws/"
  # what the workshop sends as the app's gestalts
  mkdir -p "$ws/.workshop"
  echo '["note@1","source@1","concept@2","concept@3","concept-link@1","practice-event@1","practice-event@2","flashcard@1","multiple-choice@1","item-model@1","deck@2","fsrs-data@1","practice-session@1"]' > "$ws/.workshop/gestalts.json"
  echo "example $id:"
  (cd "$ws" && node check.ts)
done
