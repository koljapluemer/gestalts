# loops-for-learning

Loops has two modes over the [gestalts](../../README.md) data model:

- **Learn** runs the learning plugins from `distribution.yml`, one view at a time.
- **Make** creates `view@1` drafts, previews them live, and can ask a local Claude CLI agent to edit them.

Learn data remains in the browser's `loops` repository and can optionally sync through Gestalter. Make deliberately
keeps the former Workshop storage contract: drafts use `workshop-views`, the local node uses `$WORKSHOP_DATA` (default
`~/gestalt-workshop-views`), and agent workspaces use `$WORKSHOP_WORKSPACES` (default
`~/.local/share/gestalt-workshop/workspaces`). Existing drafts, sessions and run logs therefore continue to work.

## Developing

From the repo root (see its README; Make's agent needs the `claude` CLI):

```sh
mise run loops:dev          # Make node on :7727 and app on :5174
mise run loops:app          # app only; Make preview still works without an agent
mise run loops:node         # local Make node only
mise run loops:build        # production static app in dist/
mise run loops:agent-stats  # summarize private local agent run logs
```

`distribution.yml` lists the learning plugins; every plugin tagged `learning` becomes a Learn tab. See
[`doc/workshop-architecture.md`](doc/workshop-architecture.md) for the local Make architecture and
[`doc/workshop-integration.md`](doc/workshop-integration.md) for the deferred promotion roadmap.
