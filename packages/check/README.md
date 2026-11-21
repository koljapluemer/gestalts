# @gestalts/check

What a draft view (`checkView`) or a viz (`checkViz`) is checked with: by whatever agent made it (it's their `check`
tool, see `packages/workshop/src/agents/tools.ts`) and by the app. The same code runs in the page
(`@gestalts/check/browser`: TypeScript in a worker, esbuild-wasm, a viz's code and renders in sandboxed frames) and
in Node (`@gestalts/check/node`, without the render).

Neither has a file system to resolve from, so `scripts/pack.ts` (part of `mise run setup`) records into `pack/`
(not committed) what TypeScript reads to typecheck against what the frame provides, and @gestalts/viz's runtime
sources for esbuild. Run it again after changing what views or vizzes may import.
