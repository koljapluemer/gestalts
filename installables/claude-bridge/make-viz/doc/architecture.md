# vizint workshop architecture

```
src/workshop/Make.tsx      the list of vizzes, and the workbench: the editor beside the vizint view showing the viz
src/workshop/Editor.tsx    a viz's title, intro, spec, outro and files; Build
src/workshop/agent.ts      the agent backend as the browser sees it: a build is a job read through event polls
src/workshop/viz.ts        a viz as a `viz@1` yml; blobs named by content
plugins/vizint-agent/      backend.py (the job and its routes), vizbuild.py (the workspace, the CLI, what comes back)
agent-template/            what the agent works against: CLAUDE.md (the contract), check.ts, check.py
```

## A build

The spec is authoritative: a build always starts from it, with the previous `viz.ts` (if any) to keep what works.
There is no chat; to change a viz, change its spec and build again.

1. The browser saves the texts and sends the spec, the previous source, the packages and the files (as base64).
2. `vizbuild.prepare` lays out the viz's workspace: the template, `@gestalts/viz`'s examples, `viz-sources` (a link
   to the package's sources), `SPEC.md`, `viz.ts`, `files/` and a `package.json` with the viz's extra packages
   (installed with npm). `node_modules` stays between builds.
3. `claude -p` runs there, allowed to read and write files, `npm install` and `node check.ts`, nothing else.
4. The backend runs `node check.ts` itself: typecheck (the repo's `tsc`), the viz's `checks` in node, the build into
   one offline page (`packages/viz/build/build.ts`), and `check.py` (Playwright, through uv) rendering it at 360 and
   1000 px, light and dark, offline, which also writes the still.
5. The `result` event carries `viz.ts`, the packages and, only if the check passed, the page and the still. The
   browser stores those as blobs named by their content and writes the yml; a failed check keeps the last page that
   passed. The agent never touches data.

The browser check is part of the gate, so building needs Chromium (`scripts/node.sh` installs it). `mise run check`
runs the same `check.ts` on `@gestalts/viz`'s examples without the browser (`scripts/check-examples.sh`).

Unlike the learning workshop, no run log is kept yet: `generator` on the yml records the agent, model and cost of the
last build that passed.
