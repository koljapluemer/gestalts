#!/usr/bin/env bash
# The node's `--plugins-dir` arguments: this repo's plugins, and gestalt-plugins' groups when it's checked out next to
# this repo (their gestalts are needed to lint and publish their decks).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
echo -n "--plugins-dir $root/plugins"
for d in "$root"/../gestalt-plugins/*/; do
  [ -n "$(ls "$d"*/plugin.yml 2>/dev/null)" ] && echo -n " --plugins-dir $(cd "$d" && pwd)"
done
echo
