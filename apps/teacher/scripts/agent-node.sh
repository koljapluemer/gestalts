#!/usr/bin/env bash
# A node that runs the claude CLI for the teacher app, on the teacher's own computer: gestalts-node from this repo,
# headless, with only the workshop agent (packages/workshop/plugins). The app reaches it from its settings ("Claude
# on this computer"); drafts stay on the teacher server, so its folder stays empty.
#   TEACHER_AGENT_PORT    default 7757
#   TEACHER_AGENT_ORIGIN  the deployed app's origin(s), space-separated, e.g. https://teacher.example.org; localhost
#                         (mise run teacher:app) is always allowed
# The agent needs the claude CLI, signed in, and the agent template's packages (mise run setup, which the mise task runs first).
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
port="${TEACHER_AGENT_PORT:-7757}"
data="${XDG_DATA_HOME:-$HOME/.local/share}/gestalt-teacher-agent/folder"
mkdir -p "$data"
origins=()
for o in ${TEACHER_AGENT_ORIGIN:-}; do origins+=(--allow-origin "$o"); done
# from the repo root, so rustup picks up its rust-toolchain.toml
cd "$root"
exec cargo run -q -p gestalts-node-desktop -- --profile teacher-agent --port "$port" --lan-port "$((port + 1))" \
  ${origins[@]+"${origins[@]}"} --plugins-dir "$root/packages/workshop/plugins" serve --data "$data"
