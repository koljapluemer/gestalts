#!/usr/bin/env bash
# Prints the first port from $1, going up by ${2:-1}, where that many ports in a row (a node's API and its home-network
# port: 2) are free on this computer, on IPv4 and IPv6, and none is one of the ports after it (taken by a server that
# hasn't started listening yet). Not a random one: browsers keep a page's data per origin, so a port that usually stays
# the same keeps your tabs between runs.
set -euo pipefail
port="$1"
count="${2:-1}"
shift $(( $# < 2 ? $# : 2 ))
taken=" $* "

busy() {
  [[ "$taken" == *" $1 "* ]] && return 0
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null || (exec 3<>"/dev/tcp/::1/$1") 2>/dev/null
}
run_busy() {
  local i
  for ((i = 0; i < count; i++)); do busy $((port + i)) && return 0; done
  return 1
}

while run_busy; do
  port=$((port + count))
done
echo "$port"
