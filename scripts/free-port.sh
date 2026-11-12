#!/usr/bin/env bash
# Prints the first free port on this computer from $1, going up by ${2:-1}. Not a random one: browsers keep a page's
# data per origin, so a port that usually stays the same keeps your tabs between runs.
set -euo pipefail
port="$1"
step="${2:-1}"
while (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; do
  port=$((port + step))
done
echo "$port"
