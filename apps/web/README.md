# web

The one web app. Each area is a path: `/notes` (the gestalter: notes and installable views in tabs), `/learn` (the
learning views, one at a time), `/viz` (interactive visualizations), `/make` and `/make-viz` (the workshops, with a
local agent), `/teach` (lessons, on the teacher server). It needs no node: the user's data is in the browser (OPFS).

- notes, learning and visualizations share the home store and `distributions/home.yml`; the desktop node, when one
  runs (`VITE_GESTALTS_NODE`, default :7717), is asked for plugin backends, `/net` and `/llm`, and the user may sync
  with it (settings)
- the workshops share a `drafts` store (`distributions/workshop.yml`), synced with the node that runs the agents
  (`VITE_AGENT_NODE`, default :7737, `mise run node`)
- each lesson draft is its own store (`distributions/teacher.yml`), synced with the teacher server under `/api`
  (`VITE_TEACHER_API` in dev, default :7740)

From the repo root: `mise run just dev` (this, the node and the teacher server), `mise run web:dev` (this alone),
`mise run web:build` (a static site in `dist/`; serve every path as `index.html`).
