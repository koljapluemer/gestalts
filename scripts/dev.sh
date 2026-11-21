#!/usr/bin/env bash
# `mise run just dev`: everything for development at once, with hot reload, stopped together (Ctrl-C, or when any of
# it exits):
#   - the web app (apps/web): notes, learning and visualizations on the home store in the browser, the workshops, the
#     teacher area
#   - the node (scripts/node.sh): the workshops' drafts sync with it, it runs the agents (the claude CLI) and the
#     plugin backends
#   - the teacher server (teacher-data/; its agent with ANTHROPIC_API_KEY), and the player it serves lessons with
# Each server gets the first free port from its usual one (scripts/free-port.sh), so it runs beside an installed node
# (7717/7718) and whatever else listens here. What they print goes to target/dev/<name>.log; this shows one overview,
# updated as they come up, and the end of the log of one that stops.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
logs="target/dev"
mkdir -p "$logs"

tty=false
[[ -t 1 ]] && tty=true
if $tty && [[ -z "${NO_COLOR:-}" ]]; then
  B=$'\e[1m' D=$'\e[2m' G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' C=$'\e[36m' N=$'\e[0m'
else
  B='' D='' G='' Y='' R='' C='' N=''
fi
# clears the rest of a line, where lines are redrawn
K=''
$tty && K=$'\e[K'

taken=()
# take VAR START [COUNT]: a free port (COUNT in a row) not handed out yet
take() {
  local p i
  p="$(scripts/free-port.sh "$2" "${3:-1}" ${taken[@]+"${taken[@]}"})"
  for ((i = 0; i < ${3:-1}; i++)); do taken+=($((p + i))); done
  printf -v "$1" '%s' "$p"
}
# the node in a step of two: the port after it is its home-network port. Clear of an installed node on 7717
take node 7737 2
take teacherapi 7740 2
take web 5173
teacherlessons=$((teacherapi + 1))

# prepare LABEL CMD...: CMD with its output in target/dev/prepare.log; on failure, the end of it
: > "$logs/prepare.log"
prepare() {
  local label="$1"; shift
  $tty && printf '  %s%s…%s\r' "$D" "$label" "$N"
  if ! "$@" >> "$logs/prepare.log" 2>&1; then
    printf '  %s✗ %s%s%s\n\n' "$R" "$label" "$N" "$K"
    tail -n 30 "$logs/prepare.log" | sed 's/^/    /'
    printf '\n  %sall of it: %s%s\n' "$D" "$logs/prepare.log" "$N"
    exit 1
  fi
  $tty && printf '%s' "$K"
  return 0
}
# dependencies, the wasm core and the agent template up to date (after a pull)
prepare "dependencies" mise run setup
# the binaries once, so the node and the teacher server don't wait on each other's cargo
prepare "Rust binaries" cargo build -q -p gestalts-node-desktop -p gestalts-teacher
# the teacher server serves lessons with the player built from here
prepare "the player" pnpm --dir apps/player build
prepare "the player, installed" cargo run -q -p gestalts-teacher -- --data teacher-data admin install-player --dist apps/player/dist

trap 'kill 0' EXIT

ids=() names=() urls=() ports=() notes=() pids=() groups=()
# serve GROUP ID NAME URL PORT NOTE CMD...: CMD in the background, its output in target/dev/ID.log; it's up once
# something listens on PORT
serve() {
  groups+=("$1") ids+=("$2") names+=("$3") urls+=("$4") ports+=("$5") notes+=("$6")
  local log="$logs/$2.log"
  shift 6
  "$@" > "$log" 2>&1 &
  pids+=($!)
}

serve servers node "node" "http://127.0.0.1:$node" "$node" "the agents and plugin backends · drafts in ${GESTALTS_DEV_DATA:-~/gestalt-workshop-views}" \
  env GESTALTS_NODE_PORT="$node" scripts/node.sh
teachernote="API · lessons on :$teacherlessons"
[[ -n "${ANTHROPIC_API_KEY:-}" ]] || teachernote+=" · $N${Y}its agent is off without ANTHROPIC_API_KEY"
serve servers teacherapi "teacher server" "http://127.0.0.1:$teacherapi" "$teacherapi" "$teachernote" \
  env TEACHER_LESSON_ORIGIN="http://127.0.0.1:$teacherlessons" cargo run -q -p gestalts-teacher -- --data teacher-data \
  serve --insecure-cookies --app "127.0.0.1:$teacherapi" --lessons "127.0.0.1:$teacherlessons"

if [[ -e teacher-data/dev-login.txt ]]; then login="lessons sign-in: teacher-data/dev-login.txt"
else login="lessons sign-in: your account, or mise run teacher:admin add-teacher / reset-password"; fi
serve apps web "web app" "http://localhost:$web/" "$web" "$login" \
  env VITE_GESTALTS_NODE="http://127.0.0.1:$node" VITE_AGENT_NODE="http://127.0.0.1:$node" \
  VITE_TEACHER_API="http://127.0.0.1:$teacherapi" pnpm --dir apps/web dev --port "$web" --strictPort

listening() { (exec 3<> "/dev/tcp/127.0.0.1/$1") 2> /dev/null || (exec 3<> "/dev/tcp/::1/$1") 2> /dev/null; }

# the overview into `out`; `waiting`: how many aren't up yet, `stopped`: the index of one that stopped, or -1
overview() {
  local i group mark
  waiting=0 stopped=-1 out=''
  for group in apps servers; do
    if [[ $group == apps ]]; then out+="  ${B}App${N}$K"$'\n'; else out+="$K"$'\n'"  ${B}Servers${N}$K"$'\n'; fi
    for i in "${!ids[@]}"; do
      [[ ${groups[$i]} == "$group" ]] || continue
      if ! kill -0 "${pids[$i]}" 2> /dev/null; then mark="$R✗$N"; stopped=$i
      elif listening "${ports[$i]}"; then mark="$G✓$N"
      else mark="$Y…$N"; waiting=$((waiting + 1)); fi
      out+="$(printf '  %s %s%-19s%s %s%-24s%s %s%s%s' "$mark" "$B" "${names[$i]}" "$N" "$C" "${urls[$i]}" "$N" "$D" "${notes[$i]}" "$N")$K"$'\n'
    done
  done
  out+="$K"$'\n'
}

stopped_report() {
  printf '  %s%s stopped%s, so everything stops. The end of %s:\n\n' "$R" "${names[$1]}" "$N" "$logs/${ids[$1]}.log"
  tail -n 30 "$logs/${ids[$1]}.log" | sed 's/^/    /'
  echo
}

printf '\n  %sgestalts dev%s  %slogs in %s/<name>.log · Ctrl-C stops everything%s\n\n' "$B" "$N" "$D" "$logs" "$N"
# redrawn in place while they start; without a terminal, printed once they're up
lines=0
started=$SECONDS
while :; do
  overview
  if $tty; then
    ((lines)) && printf '\e[%dA' "$lines"
    printf '%s' "$out"
    lines=$(printf '%s' "$out" | wc -l)
  fi
  ((stopped < 0 && waiting > 0 && SECONDS - started < 180)) || break
  sleep 1
done
$tty || printf '%s' "$out"
if ((stopped >= 0)); then stopped_report "$stopped"; exit 1; fi
if ((waiting)); then printf '  %s%d not answering after 3 minutes: see their logs%s\n\n' "$Y" "$waiting" "$N"; fi

# stop all when one stops (macOS' bash 3.2 has no `wait -n`: there, when all have)
if ((BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1] >= 403)); then wait -n || true; else wait || true; fi
for i in "${!ids[@]}"; do
  if ! kill -0 "${pids[$i]}" 2> /dev/null; then stopped_report "$i"; break; fi
done
exit 1
