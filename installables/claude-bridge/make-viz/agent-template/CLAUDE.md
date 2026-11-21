# A viz

You build one interactive visualization. It sits in a page between a short text before it and one after it; that
text is the context, so the viz itself has no title or explanation. `SPEC.md` says what it should be and is
authoritative. Work only in this folder.

## The files

- **`viz.ts`**: the viz. Its default export is `viz({...})` from `@gestalts/viz`. This and `package.json` are kept;
  nothing else is.
- **`files/`**, when present: data files the spec names by bare name ("original.png" is `files/original.png`). Use
  them instead of invented data. Never change them.
- **`examples/`**: finished vizzes to learn from (read-only), each with the `viz.yml` it was made from.
- **`package.json`**: extra npm packages, only if the spec really needs one: `npm install <name>@<exact version>`.
  Everything is bundled into one offline page.

Run **`node check.ts`** before you finish. It typechecks, runs your `checks`, builds the page, and renders it in a
headless browser at 360 and 1000 px, light and dark, with the network blocked. It reports errors, overflow and empty
renders and writes `check-<width>-<theme>.png`; look at them with Read. You're done when it passes and the
screenshots show what the spec asks for. End with one short sentence on what you built.

## What a viz is

```ts
import { viz, range, points, handles, polyline, dot, near } from '@gestalts/viz';

export default viz({
  params: { t: range(0, 1, 0.5, { step: 0.001 }), p: points([[0, 0], [0.5, 1], [1, 0]]) },
  clock: { drives: 't', duration: 4, loop: true },
  model: ({ t, p }) => ({ at: lerpAll(p, t) }),          // pure: the same params give the same model
  panels: { main: { x: [0, 1], y: [0, 1], aspect: 1.6 } },
  scene: ({ p }, m, ui) => [polyline(p, { color: 'muted' }), dot(m.at, { color: 'accent' }), handles('p')],
  checks: [{ name: 'starts at the first point', params: { t: 0 }, expect: (m, p) => near(m.at, p.p[0]) }],
});
```

- **params** are the whole state. The runtime makes their controls (native inputs, one look everywhere): you never
  build a control, a button, a slider or a legend box by hand.
  - `range(min, max, value, { step?, label?, control? })`, `toggle(value)`, `choice(['a', 'b'], 'a')`
  - `point([x, y])`, `points([...])`: dragged in a panel with `handles('<param>')`, no control of their own
  - `label` names the control (the param's name otherwise); `control: false` hides it
- **clock** (optional): time is one `range` param moving from min to max. The runtime adds play/pause, reset, speed
  and a scrubber for it. `duration` (s at 1×), `loop`, `autoplay` (rarely: let people start it).
- **model** computes everything from the params, purely. A simulation computes its whole run (`trajectory`, `rk4`,
  seeded `rng`) and the clock picks where to look. Write `model` before `panels`, `scene` and `checks` so TypeScript
  knows its type.
- **panels**: named coordinate systems, laid out in a row that wraps on narrow screens. `x`, `y` ranges; y points up
  unless `yDown` (use it for images and grids). `aspect` (width/height), `min` (px before wrapping, default 200),
  `grow` (share of the row), `pad`. A function `(params, model) => panels` when the axes must follow the data.
- **scene** `(params, model, ui)` returns marks, fresh every frame. `ui.hover` is the `link` under the pointer (a
  raster or heatmap adds `:<cell index>`); `ui.variant(name)` is the model with a named `variants` entry applied.
- **checks** are expectations about the model, run at build time. Every viz has some: known values from the spec,
  invariants, edge cases. They're how a wrong model gets caught, so make them meaningful.

## Marks

All in their panel's coordinates; `panel` names it (the first one by default).

| mark | |
|---|---|
| `dot(at, { r })` | a point |
| `line(from, to)`, `arrow(from, to, { head })` | |
| `polyline(points, { closed, fill, draw })` | `draw` 0..1: how much is drawn from the first point |
| `path(d, { fill, draw })` | SVG path data in panel coordinates |
| `rect(at, size, { fill })` | `at` is the corner with the smallest coordinates |
| `text(at, s, { size, mono, bold, align, baseline, wrap })` | `wrap`: width in panel units |
| `tex(at, latex, { size, align, display })` from `@gestalts/viz/tex` | `\class{name}{…}` makes a hoverable part linking as `name` |
| `raster(at, size, pixels, { smooth })` | an image: import `./files/x.png?pixels` (PNG or JPEG, decoded at build time) |
| `heatmap({ at, size, cols, rows, values, domain })` | values row by row, `null` empty |
| `axis('bottom' or 'left', { label, ticks, format })` | from the panel's range |
| `handles(param)` | draggable points for a `point`/`points` param |
| `custom(draw(ctx, frame))` | anything else on the canvas; `frame.px` maps coordinates, `frame.color` theme colors |

Every mark takes `color` (`'fg'`, `'muted'`, `'accent'`, `'border'`, `'surface'`, a series index `0`–`5`, or a CSS
color for data like a pixel's own color), `width`, `dash`, `opacity`, and:

- `link`: marks with the same link light up together when the pointer is over any of them (a curve and its label, a
  formula's part and what it means).
- `key` + `transition` (ms): the same thing across states, moving smoothly; new keys fade in, gone ones fade out.

Helpers: `rng(seed)`, `trajectory(init, step, steps, dt)`, `rk4(f, y, dt)`, `lerp`, `lerpVec`, `clamp`, `near`
(for checks), `ticks`, `partial`. The sources are in `viz-sources/` (read-only); read them when unsure.

## How it should look

- Show what the spec asks for and nothing more: no title, subtitle, explanatory labels, formulas, legends or card
  around it unless the spec asks. The text around it is the context.
- Use theme colors (`fg`, `muted`, `accent`, series) so light and dark both work; fixed colors only for data.
- It must work from 320 px wide: give panels a sensible `min` and `aspect`, and keep text short.
- Prefer one clear interaction over several. Animation is for things that happen in time; let people start it.
- No network, storage, `alert` or timers of your own: the clock is the only time.

When `viz.ts` already holds a previous version, keep what works and change only what the spec requires.
