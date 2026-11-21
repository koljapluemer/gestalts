# claude-bridge

`gestalts-claude-bridge` lets a website you allow run Claude Code (the `claude` CLI, signed in on this computer)
with the website's own tools. It knows nothing of what the site makes: the site sends the files, the instructions
and its tools. The bridge runs `claude -p` on them in a workspace, and hands every tool call back to the page. The
web app's `/make`, `/make-viz` and `/teach` (Claude Code on this computer) use it, with `@gestalts/check` as their
`check` tool.

- **Install:** `mise run claude-bridge:package` builds this OS's installers into `target/packages` (`.deb`, `.rpm`,
  AppImage, `.dmg`, setup `.exe`); `mise run claude-bridge:install` installs one here. It needs Claude Code, installed
  and signed in once in a terminal. It lives in the tray: whether Claude Code was found, the allowed sites,
  "Start on login" (offered on the first start), "Quit".
- **Development:** `mise run claude-bridge` (part of `mise run just dev`) runs it headless with `--dev`, so pages on
  localhost may use it without asking.

```sh
gestalts-claude-bridge                  # in the tray; one per user
gestalts-claude-bridge serve [--dev]    # headless
# both: [--port 7737] [--profile NAME]; GESTALTS_CLAUDE=/path/to/claude if it isn't found
```

## How a site uses it

All of it is on `127.0.0.1:7737`.
- `GET /status` returns `{app, version, claude: {found, path, version}, paired}`.
- `POST /pair` shows the person a dialog: "Allow <origin> to run Claude Code on this computer?". The answer is a
  token for that origin (403 if they said no). Tokens are kept in the config folder, and "Allowed sites…" in the tray
  forgets them.
- `GET /runs?token=…` is a WebSocket, one turn per socket. Closing the socket stops the turn.
  - **page → bridge:**
    - `start {workspace, session?, prompt, system?, files: {path: text}, binary?: {path: base64}, keep, tools: [{name, description, inputSchema}], model?, maxBudgetUsd?}`
    - `tool_result {id, content, isError?}` (MCP content: text and images)
    - `cancel`
  - **bridge → page:**
    - `text {text}`
    - `tool {name, summary}`
    - `tool_call {id, name, input, files}`, where `files` is the draft as it is now
    - `files {files: {path: text | null}}`: what the turn changed
    - `done {session}`
    - `error {message}`

`keep` is a regex for the draft's paths: what tool calls see and what comes back. Everything else the page sends (the
contract, examples, sources) is the template. A workspace (`<data>/workspaces/<site>/<workspace>`) is cleared and
laid out anew by every turn, so the page's draft stays the truth. The bridge tells Claude which files changed outside
the conversation since its last turn there.

## What Claude may do

Claude reads and edits only the workspace (`Read(./**)`, `Edit(./**)`, `Write(./**)`, `Glob`, `Grep`) and runs no
shell. It has no tools besides the page's, which it gets as the `gestalts` MCP server. That server is this program
(`gestalts-claude-bridge mcp`), started by claude with the turn's address and secret. It forwards each call to the
bridge (`/internal/runs/<id>`, which browsers can't reach), and the bridge asks the page.

Each turn is logged in `<data>/runs/`: the raw stream, plus one summary line a day (`workshop-agent-run@2`).
`mise run workshop:agent-stats` summarizes them (`scripts/agent_stats.py`).
