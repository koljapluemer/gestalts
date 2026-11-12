#!/usr/bin/env bash
# The node's `--plugins-dir` arguments: the repo's plugins (their gestalts are needed to lint and publish their decks).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
echo "--plugins-dir $root/plugins"
