# vizint-workshop

Make interactive visualizations for [vizint](../vizint): write a viz's title, the text before and after it, and its
spec, then build it. A local Claude CLI agent writes the viz (with [`@gestalts/viz`](../../packages/viz)) from the
spec; the workshop checks it and shows it as vizint does.

Vizzes live in the browser (`vizint-workshop`) and sync with the workshop's node, which keeps them in
`$VIZINT_WORKSHOP_DATA` (default `~/vizint-workshop-data`) and runs the agent (`plugins/vizint-agent`, workspaces in
`$VIZINT_WORKSPACES`, default `~/.local/share/vizint-workshop/workspaces`).

From the repo root (building needs the `claude` CLI, node and uv; the node script installs Chromium for the check
once):

```sh
mise run vizint-workshop:dev    # its node on :7747 and the workshop on :5179
mise run vizint-workshop:app    # the workshop only: editing and the preview work, building doesn't
mise run vizint-workshop:node   # the node only
mise run vizint-workshop:build  # static build in dist/
```

`VIZINT_MODEL` and `VIZINT_BUDGET_USD` (for the node) pick the agent's model and cap a build's cost.

See [`doc/architecture.md`](doc/architecture.md).
