#!/usr/bin/env bash
# `mise run just setup`: a new dev machine ready for `mise run just dev`, and again whenever things moved (pulled
# changes, a new tool version). Safe to run any time.
#   - the tools mise pins (Node, pnpm, uv, wasm-pack, packaging tools) and the Rust toolchain rust-toolchain.toml pins
#   - JS dependencies, the core compiled to wasm, the agent template (mise run setup)
#   - the Rust binaries `just dev` runs, built once so its first start isn't a long wait
#   - a local teacher account, the first time (teacher-data/, kept out of git)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

step() { printf '\n== %s\n' "$*"; }

missing=()
command -v rustup > /dev/null || missing+=("rustup (https://rustup.rs)")
command -v python3 > /dev/null || missing+=("python3")
if ((${#missing[@]})); then
  printf 'Install first: %s\n' "${missing[@]}" >&2
  exit 1
fi

step "tools (mise.toml)"
mise install

step "Rust (rust-toolchain.toml)"
# rustup ≥ 1.28 installs the pinned toolchain on request; older ones on first use
rustup toolchain install 2> /dev/null || rustup show active-toolchain

step "dependencies, the core in wasm, the agent template"
# a fresh mise, so it has the tools just installed
mise run setup

step "the Rust binaries"
cargo build -q -p gestalts-node-desktop -p gestalts-teacher

if [[ ! -e teacher-data/teacher.db ]]; then
  step "a local teacher account"
  teacher() { cargo run -q -p gestalts-teacher -- --data teacher-data admin "$@"; }
  school="$(teacher add-school "Dev school")"
  password="$(teacher add-teacher --school "$school" --email dev@localhost)"
  printf 'email: dev@localhost\npassword: %s\n' "$password" > teacher-data/dev-login.txt
  echo "sign in to the teacher app with dev@localhost, password in teacher-data/dev-login.txt"
fi

step "optional"
command -v claude > /dev/null || echo "no claude CLI: the workshops' and the teacher's local agent need it (https://claude.com/claude-code)"
[[ -n "${ANTHROPIC_API_KEY:-}" ]] || echo "no ANTHROPIC_API_KEY: the teacher server's own agent stays off in just dev (the local CLI agent works without it)"
echo "Android: needs the SDK and NDK, see apps/node/doc/android.md"

printf '\nReady: mise run just dev\n'
