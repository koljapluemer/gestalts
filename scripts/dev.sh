#!/usr/bin/env bash
# Everything for development at once, with hot reload, stopped together (Ctrl-C, or when any of it exits):
#   - the dev desktop node (tray, the repo's plugins, --profile dev) and its settings page
#   - the learning workshop's Make node (headless, --profile workshop)
#   - gestalter and loops-for-learning on the dev node, the learning workshop on the Make node
# Each server gets the first free port from its usual one (scripts/free-port.sh), so it runs beside an installed node
# (7717/7718) and whatever else listens here. Output is prefixed with who wrote it.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

taken=()
# take VAR START [COUNT]: a free port (COUNT in a row) not handed out yet
take() {
  local p i
  p="$(scripts/free-port.sh "$2" "${3:-1}" ${taken[@]+"${taken[@]}"})"
  for ((i = 0; i < ${3:-1}; i++)); do taken+=($((p + i))); done
  printf -v "$1" '%s' "$p"
}
# the nodes in steps of two: the port after each is its home-network port. Clear of an installed node on 7717
take node 7737 2
take make 7727 2
take gestalter 5173
take loops 5174
take workshop 5175
take settings 5176

# the node binary once, so the two nodes don't wait on each other's cargo
cargo build -q -p gestalts-node-desktop

trap 'kill 0' EXIT
# run NAME CMD...: CMD in the background, its output prefixed with NAME
run() {
  local name="$1"; shift
  "$@" > >(while IFS= read -r line; do printf '[%s] %s\n' "$name" "$line"; done) 2>&1 &
}

run node cargo run -q -p gestalts-node-desktop -- --profile dev --port "$node" --lan-port "$((node + 1))" \
  $(bash scripts/plugin-dirs.sh) --background --open-url "http://localhost:$settings/"
run make env WORKSHOP_NODE_PORT="$make" apps/learning-workshop/scripts/node.sh
run settings env GESTALTS_NODE="http://127.0.0.1:$node" pnpm --dir apps/node/settings dev --port "$settings" --strictPort
run gestalter env VITE_GESTALTS_NODE="http://127.0.0.1:$node" pnpm --dir apps/gestalter/distribution dev --port "$gestalter" --strictPort
run loops env VITE_GESTALTS_NODE="http://127.0.0.1:$node" pnpm --dir apps/loops-for-learning dev --port "$loops" --strictPort
run workshop env VITE_WORKSHOP_NODE="http://127.0.0.1:$make" pnpm --dir apps/learning-workshop dev --port "$workshop" --strictPort

cat <<EOF

  gestalter           http://localhost:$gestalter/
  loops-for-learning  http://localhost:$loops/
  learning workshop   http://localhost:$workshop/
  node settings       http://localhost:$settings/
  dev node            http://127.0.0.1:$node  (home network :$((node + 1)), profile dev)
  Make node           http://127.0.0.1:$make  (home network :$((make + 1)), profile workshop)

EOF
# stop all when one stops (macOS' bash 3.2 has no `wait -n`: there, when all have)
if ((BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1] >= 403)); then wait -n; else wait; fi
