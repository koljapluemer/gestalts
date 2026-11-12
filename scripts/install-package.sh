#!/usr/bin/env bash
# Installs the desktop app package built by `mise run node:package` with this machine's own installer.
set -euo pipefail
dir=${1:-target/packages}
newest() { ls -t "$dir"/$1 2>/dev/null | head -1; }

case "$(uname -s)" in
  Linux)
    if command -v dnf >/dev/null && [ -n "$(newest '*.rpm')" ]; then
      sudo dnf install -y "$(newest '*.rpm')"
    elif command -v apt-get >/dev/null && [ -n "$(newest '*.deb')" ]; then
      sudo apt-get install -y --reinstall "$(realpath "$(newest '*.deb')")"
    elif [ -n "$(newest '*.AppImage')" ]; then
      mkdir -p ~/Applications
      install -m 755 "$(newest '*.AppImage')" ~/Applications/gestalts-node.AppImage
      echo "installed ~/Applications/gestalts-node.AppImage"
    else
      echo "no package for this Linux in $dir" >&2; exit 1
    fi ;;
  Darwin)
    dmg=$(newest '*.dmg'); [ -n "$dmg" ] || { echo "no .dmg in $dir" >&2; exit 1; }
    mnt=$(mktemp -d)
    hdiutil attach -nobrowse -quiet -mountpoint "$mnt" "$dmg"
    trap 'hdiutil detach -quiet "$mnt"' EXIT
    rm -rf "/Applications/gestalts-node.app"
    cp -R "$mnt/gestalts-node.app" /Applications/
    echo "installed /Applications/gestalts-node.app" ;;
  MINGW*|MSYS*|CYGWIN*)
    exe=$(newest '*setup.exe'); [ -n "$exe" ] || { echo "no installer .exe in $dir" >&2; exit 1; }
    "$exe" /S
    echo "installed via $exe" ;;
  *) echo "unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
