# learning-workshop

Make learning views: create drafts (a view with its own gestalts and content, `@gestalts/workshop`), preview them
live beside the learning views, and have a local Claude CLI agent edit them. The app is the web app's `/make`
([`../../../web/app`](../../../web/app)); this folder keeps its agent's stats, tests and docs.

Drafts live in the browser (`drafts`, shared with the vizint workshop) and sync with the claude bridge (`mise run claude-bridge`,
part of `mise run just dev`), which keeps them in `$GESTALTS_DEV_DATA` (default `~/gestalt-workshop-views`) and runs the
agent (`installables/claude-bridge/plugins/workshop-agent`, shared with the teacher area; workspaces in `$WORKSHOP_WORKSPACES`,
default `~/.local/share/gestalt-workshop/workspaces`). The agent needs the `claude` CLI.

`mise run workshop:agent-stats` summarizes the private local agent run logs.

See [`doc/workshop-architecture.md`](doc/workshop-architecture.md) and, for turning a draft into a plugin,
[`doc/workshop-integration.md`](doc/workshop-integration.md).
