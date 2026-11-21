#!/usr/bin/env bash
# Rebuild every app icon from assets/icon.svg. See doc/icons.md for per-app overrides.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
fallback="$root/assets/icon.svg"

source_for() {
  local app="$1"
  if [[ -f "$root/$app/icon.svg" ]]; then
    printf '%s\n' "$root/$app/icon.svg"
  else
    printf '%s\n' "$fallback"
  fi
}

render() {
  local source="$1" size="$2" destination="$3"
  rsvg-convert --width "$size" --height "$size" --keep-aspect-ratio "$source" --output "$destination"
}

stamp() {
  node -e 'const fs=require("node:fs"),crypto=require("node:crypto"); process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex")+"\n")' "$1" > "$2"
}

web_apps=(
  apps/web
  apps/gestalter/distribution-android
  apps/node/settings
)
for app in "${web_apps[@]}"; do
  cp "$(source_for "$app")" "$root/$app/public/favicon.svg"
done

desktop_source="$(source_for apps/node/desktop)"
render "$desktop_source" 256 "$root/apps/node/desktop/assets/icon.png"
stamp "$desktop_source" "$root/apps/node/desktop/assets/icon.source.sha256"

android_source="$(source_for apps/node/android)"
(cd "$root/apps/node/android" && mise exec -- cargo tauri icon "$android_source")
stamp "$android_source" "$root/apps/node/android/icons/icon.source.sha256"

echo "Updated web, desktop and Android icons."
