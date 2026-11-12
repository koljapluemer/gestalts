# @gestalts/viz

What an interactive visualization is written with, and its runtime: `params`, at most one `clock`, a pure `model`, and
a `scene` of marks drawn from them. The runtime makes the controls (from the params), draws (canvas, with `tex` as
MathML over it), handles dragging, hover links, keyed transitions, the theme and the messages to the page around it.
Nothing else in the repo is imported.

- The contract a viz is written against is the agent's: [`apps/vizint-workshop/agent-template/CLAUDE.md`](../../apps/vizint-workshop/agent-template/CLAUDE.md).
- `examples/` are complete vizzes (`viz.ts`, `viz.yml`, `files/`); `mise run vizint:deck` publishes them as
  `plugins/vizint`'s examples deck.
- `node build/build.ts build|check <dir>` builds a viz folder into one offline page (`dist/index.html`), or runs its
  checks in node.
- `src/protocol.ts` is what a built page and the page around it say to each other.
