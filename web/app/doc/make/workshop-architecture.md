# Make (`/make`): the learning workshop

```
web/app/src/make/Make.tsx    the list of drafts, and the workbench

packages/workshop/           shared with the teacher app:
  draft.ts                   a draft as ymls (`view@2` and its members) and as the files the agent sees
  Preview.tsx                compiles a draft's view in the browser and runs it in a frame, as any view runs
  Chat.tsx                   one conversation about one draft
  agents/                    what an agent backend is; the teacher server's (a job over HTTP, jobs.ts); Claude Code
                             through the Claude bridge (bridge.ts); the agents' tools (tools.ts); the template sent
                             with each turn (template.ts)
  agent-template/            what the agent works against: its contract (CLAUDE.md), examples
packages/check/              the `check` tool, run in the page (and in Node, by the tests)
installables/claude-bridge/  runs `claude -p` on this computer for a site the person allowed
```

A draft is a `view@2` yml and its `members`: `gestalt@1` definitions of its own gestalts (named in the draft's
`package`) and the ymls it ships with. What the view writes while it's tried out isn't a member. A `view@1` reads as
a draft without members.

A turn: the browser sends the bridge the draft as files (`view.tsx`, `view.json`, `gestalts/<name>@<N>.yml`,
`data/<id>.yml`), the template (the contract, the examples, and the sources of what a view may import, under
`node_modules/@gestalts/*/src`), and any errors the preview reported or the last save refused (`runtime-errors.md`).
Claude reads and edits them in the bridge's workspace for this draft. Its `check` tool comes back to this page, which
runs `@gestalts/check` on the draft as it is then: the compile the preview does, a typecheck (TypeScript in a worker,
on types recorded by `packages/check/scripts/pack.ts`), `view.json`, `gestalts/`, `data/` and the npm imports pinned.
At the end the bridge hands back the files that changed; the browser turns those into ymls and writes them,
definitions first. What the repo refuses goes with the next message. The agent never touches any data, and the check
is the app's, whichever model runs the turn.

A turn has no deadline: it lasts as long as its socket. Stop (or leaving the page) closes the socket, which stops
claude; what it changed until then still comes back. The CLI's session is resumed in the same workspace, and the
bridge tells it which files changed outside the conversation.

Tailwind's browser build runs in the frame here, because a vibecoded view's classes aren't known at build time.

A vibecoded view runs only in Make mode for now. Its `reads` and `writes` come from what the agent declared in
`view.json`, and there is no prompt when they widen. Chat history isn't kept across reloads; the CLI's session is.

## Agent run logs

The Claude bridge records every turn locally under its data folder's `runs/` (on Linux
`~/.local/share/gestalts-claude-bridge/runs`). Daily `workshop-agent-run@2` JSONL files distinguish the
turn's process outcome (`completed`, `failed` or `cancelled`), its final check result and permission warnings. Wall and
provider timings, token/cache usage and tools belong to that run. Claude's API time, cost and model usage are cumulative
for a resumed session, so they live under `session_totals`; reports count only the latest totals for each session.
`raw/<date>/<run>.jsonl` contains the complete Claude stream with receipt timing, including assistant and tool content;
it is private local data and is kept until manually deleted. Prompts and view files are not copied into the normalized
record. Older record schemas are left untouched and ignored by the report.

Run `mise run workshop:agent-stats`, optionally followed by `-- --days N`, `--view ID`, `--limit N` or `--json`, to summarize
the journal. A failed logging write is reported on the bridge's stderr but never changes the turn's result.
