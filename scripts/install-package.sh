#!/usr/bin/env bash
# Installs a desktop package built by `mise run node:package` (default) or `mise run claude-bridge:package` with this
# machine's own installer: `install-package.sh DIR [NAME]`, NAME gestalts-node or gestalts-claude-bridge.
set -euo pipefail
dir=${1:-target/packages}
name=${2:-gestalts-node}
newest() { ls -t "$dir"/$name[_-]$1 2>/dev/null | head -1; }

case "$(uname -s)" in
  Linux)
    if command -v dnf >/dev/null && [ -n "$(newest '*.rpm')" ]; then
      sudo dnf install -y "$(newest '*.rpm')"
    elif command -v apt-get >/dev/null && [ -n "$(newest '*.deb')" ]; then
      sudo apt-get install -y --reinstall "$(realpath "$(newest '*.deb')")"
    elif [ -n "$(newest '*.AppImage')" ]; then
      mkdir -p ~/Applications
      install -m 755 "$(newest '*.AppImage')" ~/Applications/$name.AppImage
      echo "installed ~/Applications/$name.AppImage"
    else
      echo "no package for this Linux in $dir" >&2; exit 1
    fi ;;
  Darwin)
    dmg=$(newest '*.dmg'); [ -n "$dmg" ] || { echo "no .dmg in $dir" >&2; exit 1; }
    mnt=$(mktemp -d)
    hdiutil attach -nobrowse -quiet -mountpoint "$mnt" "$dmg"
    trap 'hdiutil detach -quiet "$mnt"' EXIT
    rm -rf "/Applications/$name.app"
    cp -R "$mnt/$name.app" /Applications/
    echo "installed /Applications/$name.app" ;;
  MINGW*|MSYS*|CYGWIN*)
    exe=$(newest '*setup.exe'); [ -n "$exe" ] || { echo "no installer .exe in $dir" >&2; exit 1; }
    "$exe" /S
    echo "installed via $exe" ;;
  *) echo "unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
