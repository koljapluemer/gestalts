# Sourced by the Android tasks (from installables/folder-sync/android): which page the Android app wraps. The shell itself (sync,
# pairing, the commands) is the same for every distribution.
#   GESTALTS_ANDROID_DISTRIBUTION  the page's folder from the repo root, default web/android
dist="../../../${GESTALTS_ANDROID_DISTRIBUTION:-web/android}"
[ -f "$dist/distribution.yml" ] || { echo "no distribution.yml in $dist" >&2; exit 1; }

# The Tauri config for it, as `--config` JSON; with a dev URL ($1) for `android dev`.
distribution_config() {
  local dev=""
  [ -n "${1:-}" ] && dev=",\"devUrl\":\"$1\""
  printf '{"build":{"frontendDist":"%s/dist","beforeDevCommand":{"script":"pnpm dev","cwd":"%s"},"beforeBuildCommand":{"script":"pnpm build","cwd":"%s"}%s}}' \
    "$dist" "$dist" "$dist" "$dev"
}
