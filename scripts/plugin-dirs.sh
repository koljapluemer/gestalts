#!/usr/bin/env bash
# The node's `--plugins-dir` and `--models-dir` arguments: the repo's plugins and model packages (the gestalts beyond
# the core's, needed to lint and publish the decks).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
echo "--plugins-dir $root/plugins --models-dir $root/gestalts"
