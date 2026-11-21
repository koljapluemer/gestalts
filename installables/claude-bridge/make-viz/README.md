# vizint-workshop

Make interactive visualizations for the web app's `/viz`: write a viz's title, the text before and after it, and its
spec, then build it. A local Claude CLI agent writes the viz (with [`@gestalts/viz`](../../../packages/viz)) from the
spec; the workshop checks it and shows it as `/viz` does. The app is the web app's `/make-viz`
([`../../../web/app`](../../../web/app)); this folder keeps its agent's template, tests and docs; the agent is
`../plugins/vizint-agent`.

Vizzes live in the browser (`drafts`, shared with the learning workshop) and sync with the claude bridge (`mise run
claude-bridge`, part of `mise run just dev`), which keeps them in `$GESTALTS_DEV_DATA` (default `~/gestalt-workshop-views`) and runs
the agent (workspaces in `$VIZINT_WORKSPACES`, default `~/.local/share/vizint-workshop/workspaces`). Building needs the
`claude` CLI, node and uv; `scripts/claude-bridge.sh` installs Chromium for the check once. Vizzes made before, in
`~/vizint-workshop-data`, come back by copying its `notes/` and `blobs/` into the bridge's folder.

`VIZINT_MODEL` and `VIZINT_BUDGET_USD` (for the bridge) pick the agent's model and cap a build's cost.

See [`doc/architecture.md`](doc/architecture.md).
