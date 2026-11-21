#!/usr/bin/env bash
# The Claude bridge for development (`mise run claude-bridge`, installables/claude-bridge): headless, with the dev
# profile (its own allowed sites and workspaces), and pages on localhost may use it without asking.
#   GESTALTS_BRIDGE_PORT   default 7737
# It runs the claude CLI, which must be installed and signed in; the web app's pages bring everything else.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
port="${GESTALTS_BRIDGE_PORT:-7737}"
# from the repo root, so rustup picks up its rust-toolchain.toml
cd "$root"
exec cargo run -q -p gestalts-claude-bridge -- serve --dev --profile dev --port "$port"
