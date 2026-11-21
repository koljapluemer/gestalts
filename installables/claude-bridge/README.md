# claude-bridge

`gestalts-claude-bridge`: runs the `claude` CLI on this computer for the web app's agents: `/make` (workshop-agent),
`/make-viz` (vizint-agent) and `/teach`'s "Claude Code on this computer" (workshop-agent). The app syncs its drafts
with the bridge's folder and asks its agent plugins for turns. It is `crates/node` with those plugins, apart from
folder-sync: port 7737, its own settings and drafts (`--data`, default in this user's app data), no tray, page or home
network.

Not packaged yet: it runs from a checkout, whose `plugins/`, agent templates (with their dependencies, `mise run
setup`) and `gestalts/` it uses in place. `mise run claude-bridge` (part of `mise run just dev`) runs it with the
drafts in `$GESTALTS_DEV_DATA` (default `~/gestalt-workshop-views`).

```
plugins/    workshop-agent (template: packages/workshop/agent-template, shared with the server's agent), vizint-agent
make/       the learning workshop's agent: stats, tests, docs
make-viz/   the viz workshop's agent: its template, tests, docs
```
