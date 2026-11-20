#!/usr/bin/env bash
# Ships the teacher app to the box at $TEACHER_HOST (ssh, as root), from a clean, committed tree, so what runs is a
# commit: the server built here, the app and the player built here, and the parts of the checkout the worker and the
# agent read (apps/teacher/worker, packages/), whose npm dependencies are installed there. The box's setup is in
# deploy/teacher/README.md.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${TEACHER_HOST:?set TEACHER_HOST to the box, e.g. root@lehrer.example.de}"

if [ -n "$(git status --porcelain)" ]; then
  echo "uncommitted changes: commit first, so the deploy is a commit" >&2; exit 1
fi
sha="$(git rev-parse --short HEAD)"
release="/opt/gestalts-teacher/releases/$sha"

cargo build --release -q -p gestalts-teacher
pnpm --dir apps/teacher build
pnpm --dir apps/player build

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git archive --format=tar HEAD apps/teacher/worker apps/teacher/package.json packages gestalts package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json | tar -x -C "$tmp"
mkdir -p "$tmp/bin" "$tmp/player"
cp target/release/gestalts-teacher "$tmp/bin/"
cp -r apps/teacher/dist "$tmp/app"
cp -r apps/player/dist/. "$tmp/player/"

ssh "$TEACHER_HOST" "mkdir -p $release"
tar -C "$tmp" -c . | ssh "$TEACHER_HOST" "tar -x -C $release"
ssh "$TEACHER_HOST" bash -s <<REMOTE
set -euo pipefail
cd $release
# only what the worker needs, from the lockfile
pnpm install --frozen-lockfile --filter teacher... >/dev/null
pnpm -C packages/workshop/agent-template install --ignore-workspace --frozen-lockfile >/dev/null
chown -R teacher: $release
sudo -u teacher bin/gestalts-teacher --data /var/lib/gestalts-teacher admin install-player --dist player
ln -sfn $release /opt/gestalts-teacher/current
systemctl restart gestalts-teacher
systemctl reload caddy
REMOTE
echo "deployed $sha to $TEACHER_HOST"
