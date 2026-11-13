#!/usr/bin/env bash
# Builds the public websites and deploys each to its Netlify site, from a clean, committed tree so what is live is a
# commit. Needs `netlify login` once on this machine. The sites have git builds stopped: they only change from here.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "uncommitted changes: commit first, so the deploy is a commit" >&2; exit 1
fi
sha="$(git rev-parse --short HEAD)"
netlify=(pnpm dlx netlify-cli@27.17.0)

# app folder (built by `pnpm --dir <folder> build` into <folder>/dist) | Netlify site id | domain
sites=(
  "apps/gestalter/distribution|fc19a848-6748-4400-b969-0917eb4aae6c|gestalter.koljasam.com"
  "apps/loops-for-learning|2f1019f9-f002-4d23-8765-60d880d2fcfa|loop.koljasam.com"
  "apps/vizint|19e53230-3e1a-45c7-b252-059204a34cf8|vizint.koljasam.com"
)

for s in "${sites[@]}"; do
  IFS='|' read -r dir _ _ <<<"$s"
  pnpm --dir "$dir" build
done
for s in "${sites[@]}"; do
  IFS='|' read -r dir id domain <<<"$s"
  "${netlify[@]}" deploy --prod --no-build --dir "$dir/dist" --site "$id" --message "$sha"
  echo "deployed $sha to https://$domain"
done
