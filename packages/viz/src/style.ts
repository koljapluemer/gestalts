/** The runtime's look: theme tokens (thea's `--viz-*`), panels and the controls. Injected by `mount`. */
export const CSS = `
:root { --viz-bg: transparent; --viz-surface: #f4f4f5; --viz-fg: #18181b; --viz-muted: #71717a; --viz-border: #e4e4e7;
  --viz-accent: #2563eb; --viz-series: #2563eb, #ea580c, #16a34a, #9333ea, #db2777, #0891b2;
  --viz-font: system-ui, "Noto Sans", "DejaVu Sans", sans-serif; --viz-mono: ui-monospace, "DejaVu Sans Mono", monospace;
  color-scheme: light; color: var(--viz-fg); background: var(--viz-bg); font: 15px/1.5 var(--viz-font); }
:root[data-theme="dark"] { --viz-surface: #27272a; --viz-fg: #f4f4f5; --viz-muted: #a1a1aa; --viz-border: #3f3f46;
  --viz-accent: #60a5fa; --viz-series: #60a5fa, #fb923c, #4ade80, #c084fc, #f472b6, #22d3ee; color-scheme: dark; }
html, body { margin: 0; background: var(--viz-bg); }
.viz-root { display: flex; flex-direction: column; gap: 12px; padding: 4px 0; }
.viz-panels { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; }
.viz-panel { position: relative; min-width: 0; }
.viz-panel canvas { display: block; width: 100%; }
.viz-panel.viz-drag canvas { touch-action: none; }
.viz-overlay { position: absolute; inset: 0; pointer-events: none; }
.viz-tex { position: absolute; pointer-events: auto; white-space: nowrap; line-height: 1; }
.viz-tex math { display: block; }
.viz-tex [class]:not(math):not([class^="tml"]) { transition: color 120ms; }
.viz-tex .viz-hot { color: var(--viz-accent); }
.viz-controls { display: flex; flex-wrap: wrap; gap: 8px 20px; align-items: center; font-size: 14px; color: var(--viz-muted); }
.viz-controls label { display: flex; align-items: center; gap: 8px; }
.viz-controls .viz-clock { display: flex; align-items: center; gap: 8px; flex: 1 1 100%; }
.viz-controls .viz-clock input[type=range] { flex: 1; }
.viz-controls input, .viz-controls select, .viz-controls button { font: inherit; color: var(--viz-fg); accent-color: var(--viz-accent); }
.viz-controls select, .viz-controls button { background: var(--viz-surface); border: 1px solid var(--viz-border); border-radius: 6px; padding: 2px 8px; }
.viz-controls button { cursor: pointer; min-width: 2.2em; }
.viz-controls button:focus-visible, .viz-controls input:focus-visible, .viz-controls select:focus-visible { outline: 2px solid var(--viz-accent); outline-offset: 2px; }
.viz-controls output { font-family: var(--viz-mono); color: var(--viz-fg); min-width: 4ch; }
.viz-error { margin: 0; padding: 8px 12px; border: 1px solid var(--viz-border); border-radius: 6px; color: var(--viz-fg);
  font: 13px/1.4 var(--viz-mono); white-space: pre-wrap; }
`;
