# learning-workshop

Make learning views: create `view@1` drafts, preview them live beside the learning views of loops-for-learning, and
have a local Claude CLI agent edit them. Deployed apart from loops-for-learning's public site.

Drafts live in the browser (`workshop-views`) and sync with the local Make node, which keeps them in `$WORKSHOP_DATA`
(default `~/gestalt-workshop-views`) and runs the agent (`plugins/workshop-agent`, workspaces in
`$WORKSHOP_WORKSPACES`, default `~/.local/share/gestalt-workshop/workspaces`).

From the repo root (the agent needs the `claude` CLI):

```sh
mise run workshop:dev          # Make node on :7727 and the workshop on :5175
mise run workshop:app          # the workshop only; preview works without an agent
mise run workshop:node         # the Make node only
mise run workshop:build        # static build in dist/
mise run workshop:agent-stats  # summarize private local agent run logs
```

See [`doc/workshop-architecture.md`](doc/workshop-architecture.md) and, for turning a draft into a plugin,
[`doc/workshop-integration.md`](doc/workshop-integration.md).
