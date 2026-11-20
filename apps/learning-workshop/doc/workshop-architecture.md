# Learning workshop architecture

```
src/workshop/Make.tsx        the list of drafts, and the workbench
src/workshop/agents/cli.ts   the claude CLI behind the node, as an agent backend
plugins/workshop-agent/      backend.py: one turn of the claude CLI

packages/workshop/           shared with the teacher app:
  draft.ts                   a draft as ymls (`view@2` and its members) and as the files the agent sees
  Preview.tsx                compiles a draft's view in the browser and runs it in a frame, as any view runs
  Chat.tsx                   one conversation about one draft
  agents/                    what an agent backend is; one run as a job over HTTP
  agent-template/            what the agent works against: its contract (CLAUDE.md), `check.ts`, examples
```

A draft is a `view@2` yml and its `members`: `gestalt@1` definitions of its own gestalts (named in the draft's
`package`) and the ymls it ships with. What the view writes while it's tried out isn't a member. A `view@1` reads as
a draft without members.

A turn: the browser sends the draft as files (`view.tsx`, `view.json`, `gestalts/<name>@<N>.yml`, `data/<id>.yml`), the
gestalts the app has, and any errors the preview reported or the last save refused. The backend writes them into a
workspace per view, runs `claude -p` there and streams back what it said and did, then the files it changed. The
browser turns those into ymls and writes them, definitions first; what the repo refuses goes with the next message.
The agent never touches any data, and another backend can take this one's place.

The node's proxy currently gives each service request 180 s, but that is not a turn deadline. A turn is a cancellable
job with no overall deadline; the browser reads it through `/events` requests that long-poll for at most 20 s each.
Finished jobs remain available for 10 minutes so the browser can collect their last events.

Tailwind's browser build runs in the frame here, because a vibecoded view's classes aren't known at build time.

A vibecoded view runs only in Make mode for now. Its `reads` and `writes` come from what the agent declared in
`view.json`, and there is no prompt when they widen. Chat history isn't kept across reloads; the CLI's session is.

## Agent run logs

The backend records every turn locally under
`$WORKSHOP_WORKSPACES/.workshop/runs` (by default
`~/.local/share/gestalt-workshop/workspaces/.workshop/runs`). Daily `workshop-agent-run@2` JSONL files distinguish the
turn's process outcome (`completed`, `failed` or `cancelled`), its final check result and permission warnings. Wall and
provider timings, token/cache usage and tools belong to that run. Claude's API time, cost and model usage are cumulative
for a resumed session, so they live under `session_totals`; reports count only the latest totals for each session.
`raw/<date>/<run>.jsonl` contains the complete Claude stream with receipt timing, including assistant and tool content;
it is private local data and is kept until manually deleted. Prompts and view files are not copied into the normalized
record. Older record schemas are left untouched and ignored by the report.

Run `mise run workshop:agent-stats`, optionally followed by `-- --days N`, `--view ID`, `--limit N` or `--json`, to summarize
the journal. A failed logging write is reported to the node's stderr but never changes the agent turn's result.
