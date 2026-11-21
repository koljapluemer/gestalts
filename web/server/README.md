# teacher

Teachers make interactive lessons with an agent and publish them to their students by link. The app is the web
app's `/teach` ([`../app`](../app)); the server is this folder (`gestalts-teacher`), with its worker
in `worker/`; lessons open in `web/player` on another domain. See
[`doc/architecture.md`](doc/architecture.md) and, for the box, [`deploy/`](deploy/README.md).

Locally, `mise run just dev` runs it all, with the server's agent if `ANTHROPIC_API_KEY` is set; `mise run just setup`
made a teacher account (`teacher-data/dev-login.txt`). Piece by piece, from the repo root:

```sh
mise run teacher:admin add-school "Test"                          # prints its id
mise run teacher:admin add-teacher --school <id> --email a@b.c    # prints a password
ANTHROPIC_API_KEY=… mise run teacher:serve                        # API on :7740, lessons on :7741
mise run web:dev                                                  # the app; /teach, /api from :7740
```

Published links point at `http://127.0.0.1:7741/l/<lesson>`.

To make lessons with the `claude` CLI on your own computer instead of the server's agent: `mise run claude-bridge` (:7737;
`TEACHER_AGENT_ORIGIN=https://…` to allow the deployed app), then Settings → Claude Code on this computer.
