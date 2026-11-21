#!/usr/bin/env bash
# The claude bridge for development (`mise run claude-bridge`, installables/claude-bridge): the web app's workshops
# sync their drafts with its folder, and it runs their agents and the teacher area's CLI agent.
#   GESTALTS_DEV_DATA        the drafts' folder (notes/ + blobs/), default ~/gestalt-workshop-views
#   GESTALTS_BRIDGE_PORT     default 7737
#   TEACHER_AGENT_ORIGIN     further origins allowed, space-separated (a deployed app); localhost always is
# The agents need the claude CLI, signed in, and the agent template's packages (mise run setup). Chromium for the viz
# agent's browser check is installed once, through uv.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
data="${GESTALTS_DEV_DATA:-$HOME/gestalt-workshop-views}"
port="${GESTALTS_BRIDGE_PORT:-7737}"
mkdir -p "$data"
uv run --quiet --with playwright==1.65.0 playwright install chromium
origins=()
for o in ${TEACHER_AGENT_ORIGIN:-}; do origins+=(--allow-origin "$o"); done
# from the repo root, so rustup picks up its rust-toolchain.toml
cd "$root"
exec cargo run -q -p gestalts-claude-bridge -- --profile dev --port "$port" ${origins[@]+"${origins[@]}"} --data "$data"
