/**
 * Runs a viz in the page: the panels and their canvases, the controls, the clock, dragging, hover, the theme and the
 * messages to and from the page around it. A built viz calls `mount(def)` once; nothing else touches the DOM.
 */
import { makeControls } from './controls';
import { DEFAULT_PANELS, type Panel, type Ui, type Viz } from './def';
import { colorOf, drawMark, hitTest, isHot, mapping, type Box, type Mapping, type Theme } from './draw';
import type { Color, Frame, Mark } from './marks';
import { overlayFor } from './overlays';
import { coerce, decodeAll, defaults, encodeAll, type ParamSpecs, type Values, type Vec } from './params';
import type { Down, Up } from './protocol';
import { CSS } from './style';
import { Tweens } from './tween';

const post = (m: Up) => { if (parent !== window) parent.postMessage(m, '*'); };

function readTheme(): Theme {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  const probe = document.createElement('canvas').getContext('2d')!;
  const cache = new Map<string, [number, number, number]>();
  return {
    fg: v('--viz-fg'), muted: v('--viz-muted'), accent: v('--viz-accent'), border: v('--viz-border'), surface: v('--viz-surface'),
    series: v('--viz-series').split(',').map((c) => c.trim()).filter(Boolean),
    font: v('--viz-font'), mono: v('--viz-mono'),
    rgb(css) {
      let c = cache.get(css);
      if (!c) {
        probe.fillStyle = '#000';
        probe.fillStyle = css;
        const f = probe.fillStyle;
        const m = f.startsWith('#') ? [1, 3, 5].map((i) => parseInt(f.slice(i, i + 2), 16)) : (f.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number);
        c = [m[0], m[1], m[2]];
        cache.set(css, c);
      }
      return c;
    },
  };
}

function applyTheme(mode: 'light' | 'dark') {
  document.documentElement.dataset.theme = mode;
}

type PanelView = { name: string; spec: Panel; el: HTMLDivElement; canvas: HTMLCanvasElement; overlay: HTMLDivElement; width: number; map?: Mapping; marks: Mark[]; overlays: Map<string, HTMLElement> };

const padOf = (spec: Panel, marks: readonly Mark[]): Omit<Box, 'width' | 'height'> => {
  const p = typeof spec.pad === 'number' ? { top: spec.pad, right: spec.pad, bottom: spec.pad, left: spec.pad } : { top: 8, right: 8, bottom: 8, left: 8, ...spec.pad };
  const axes = new Set(marks.filter((m) => m.type === 'axis').map((m) => (m as { side: string }).side));
  if (typeof spec.pad !== 'number' && !spec.pad?.bottom && axes.has('bottom')) p.bottom = 32;
  if (typeof spec.pad !== 'number' && !spec.pad?.left && axes.has('left')) p.left = 40;
  return p;
};

export function mount<S extends ParamSpecs, M>(def: Viz<S, M>, root: HTMLElement = document.getElementById('viz') ?? document.body): void {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.prepend(style);
  applyTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  addEventListener('error', (e) => post({ source: 'viz', type: 'error', message: String(e.message || e.error) }));
  addEventListener('unhandledrejection', (e) => post({ source: 'viz', type: 'error', message: String(e.reason?.message ?? e.reason) }));

  const specs = def.params;
  const panelsOf = (v: Values<S>, m: M): Record<string, Panel> => {
    const p = typeof def.panels === 'function' ? def.panels(v, m) : def.panels;
    return p && Object.keys(p).length ? p : DEFAULT_PANELS;
  };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let values: Values<S> = defaults(specs);
  let model = undefined as M;
  let modelFor: Values<S> | undefined;
  let panelSpecs = DEFAULT_PANELS;
  try {
    model = def.model(values);
    modelFor = values;
    panelSpecs = panelsOf(values, model);
  } catch { /* the first frame shows the error */ }
  const firstPanel = Object.keys(panelSpecs)[0];
  const variants = new Map<string, M>();
  let theme = readTheme();
  let hover: string | null = null;
  /** the handle under the pointer, `<param>:<index>` */
  let grab: string | null = null;
  let playing = false;
  let speed = 1;
  let last = 0;
  let scheduled = false;
  let drag: { panel: PanelView; param: string; index: number } | null = null;
  const tweens = new Tweens();

  const wrap = document.createElement('div');
  wrap.className = 'viz-root';
  const panelsEl = document.createElement('div');
  panelsEl.className = 'viz-panels';
  const errorEl = document.createElement('pre');
  errorEl.className = 'viz-error';
  errorEl.hidden = true;

  const panels: PanelView[] = Object.entries(panelSpecs).map(([name, spec]) => {
    const el = document.createElement('div');
    el.className = 'viz-panel';
    el.style.flex = `${spec.grow ?? 1} 1 ${spec.min ?? 200}px`;
    const canvas = document.createElement('canvas');
    const overlay = document.createElement('div');
    overlay.className = 'viz-overlay';
    el.append(canvas, overlay);
    panelsEl.append(el);
    return { name, spec, el, canvas, overlay, width: 0, marks: [], overlays: new Map() };
  });

  // --- params ---

  let sendTimer: ReturnType<typeof setTimeout> | undefined;
  const sendParams = () => {
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => post({ source: 'viz', type: 'params', params: encodeAll(specs, values) }), 250);
  };

  function set(changes: Record<string, unknown>, byUser: boolean) {
    const next: Record<string, unknown> = { ...values };
    for (const [k, v] of Object.entries(changes)) {
      const spec = specs[k];
      const c = spec && coerce(spec, v);
      if (c !== undefined) next[k] = c;
    }
    values = next as Values<S>;
    if (byUser) sendParams();
    schedule();
  }

  const clock = def.clock;
  const controls = makeControls(specs, clock as never, {
    set: (name, v) => { if (clock?.drives === name) playing = false; set({ [name]: v }, true); },
    play: () => {
      if (!clock) return;
      const spec = specs[clock.drives] as { min: number; max: number };
      if (!clock.loop && (values[clock.drives] as number) >= spec.max) set({ [clock.drives]: spec.min }, false);
      playing = true;
      last = 0;
      schedule();
    },
    pause: () => { playing = false; sendParams(); schedule(); },
    reset: () => {
      playing = false;
      if (clock) set({ [clock.drives]: (specs[clock.drives] as { value: number }).value }, true);
      schedule();
    },
    speed: (s) => { speed = s; schedule(); },
  });
  wrap.append(panelsEl, controls.el, errorEl);
  root.append(wrap);

  // --- the clock ---

  function tick(now: number) {
    if (!clock || !playing) return;
    const spec = specs[clock.drives] as { min: number; max: number };
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    let v = (values[clock.drives] as number) + ((spec.max - spec.min) / (clock.duration ?? 5)) * speed * dt;
    if (v > spec.max) {
      if (clock.loop) v = spec.min + ((v - spec.min) % (spec.max - spec.min || 1));
      else { v = spec.max; playing = false; sendParams(); }
    }
    set({ [clock.drives]: v }, false);
  }

  // --- drawing ---

  const ui: Ui<M> = {
    get hover() { return hover; },
    variant: (name: string) => {
      let m = variants.get(name);
      if (m === undefined) {
        m = def.model({ ...values, ...def.variants?.[name] } as Values<S>);
        variants.set(name, m);
      }
      return m;
    },
  };

  function fail(e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    errorEl.textContent = message;
    errorEl.hidden = false;
    post({ source: 'viz', type: 'error', message });
  }

  function frame(now: number) {
    scheduled = false;
    tick(now);
    let marks: Mark[];
    try {
      if (modelFor !== values) {
        model = def.model(values);
        modelFor = values;
        variants.clear();
      }
      const specsNow = panelsOf(values, model);
      for (const p of panels) p.spec = specsNow[p.name] ?? p.spec;
      marks = tweens.frame(def.scene(values, model, ui), now);
      errorEl.hidden = true;
    } catch (e) {
      fail(e);
      return;
    }
    for (const p of panels) p.marks = [];
    for (const m of marks) {
      const p = panels.find((q) => q.name === (m.panel ?? firstPanel));
      if (p) p.marks.push(m);
    }
    for (const p of panels) drawPanel(p);
    controls.sync(values, playing, speed);
    if (playing || tweens.active) schedule();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(frame);
  }

  function drawPanel(p: PanelView) {
    const width = p.el.clientWidth;
    if (!width) return;
    const { spec } = p;
    const pad = padOf(spec, p.marks);
    const dx = Math.abs(spec.x[1] - spec.x[0]), dy = Math.abs(spec.y[1] - spec.y[0]);
    const height = spec.aspect
      ? Math.round(width / spec.aspect)
      : Math.round(((width - pad.left - pad.right) * dy) / dx + pad.top + pad.bottom);
    const dpr = devicePixelRatio || 1;
    if (p.canvas.width !== Math.round(width * dpr) || p.canvas.height !== Math.round(height * dpr)) {
      p.canvas.width = Math.round(width * dpr);
      p.canvas.height = Math.round(height * dpr);
      p.canvas.style.height = `${height}px`;
    }
    const map = mapping(spec, { width, height, ...pad });
    p.map = map;
    const ctx = p.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const f: Frame = { width, height, px: map.px, color: (c) => colorOf(theme, c) };
    const used = new Set<string>();
    p.el.classList.toggle('viz-drag', p.marks.some((m) => m.type === 'handles'));
    p.marks.forEach((m, i) => {
      if (m.type === 'handles') return drawHandles(ctx, m.param, m.color, map);
      const o = overlayFor(m.type);
      if (!o) return drawMark(ctx, m, map, spec, theme, hover, f);
      const look = `${m.key ?? i}|${o.look(m)}`;
      let node = p.overlays.get(look);
      if (!node) {
        node = o.render(m);
        p.overlays.set(look, node);
        p.overlay.append(node);
      }
      used.add(look);
      const [x, y] = map.px((m as { at: Vec }).at);
      const align = (m as { align?: string }).align;
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
      node.style.opacity = String(m.opacity ?? 1);
      node.style.transform = `translate(${align === 'start' ? '0' : align === 'end' ? '-100%' : '-50%'}, -50%)`;
      node.style.color = isHot(m, hover) ? theme.accent : '';
      for (const part of node.querySelectorAll<HTMLElement>('[class]')) part.classList.toggle('viz-hot', !!hover && part.classList.contains(hover));
    });
    for (const [look, node] of p.overlays) if (!used.has(look)) { node.remove(); p.overlays.delete(look); }
  }

  function handlePoints(param: string): Vec[] {
    const v = values[param];
    const spec = specs[param];
    if (!spec) return [];
    return spec.kind === 'point' ? [v as Vec] : spec.kind === 'points' ? [...(v as Vec[])] : [];
  }

  function drawHandles(ctx: CanvasRenderingContext2D, param: string, color: Color | undefined, map: Mapping) {
    for (const [i, pt] of handlePoints(param).entries()) {
      const [x, y] = map.px(pt);
      const hot = grab === `${param}:${i}` || (drag?.param === param && drag.index === i);
      ctx.beginPath();
      ctx.arc(x, y, hot ? 8 : 6.5, 0, Math.PI * 2);
      ctx.fillStyle = theme.surface;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = colorOf(theme, color, 'accent');
      ctx.stroke();
    }
  }

  // --- pointer ---

  const local = (p: PanelView, e: PointerEvent): Vec => {
    const r = p.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  function handleAt(p: PanelView, q: Vec): { param: string; index: number } | null {
    if (!p.map) return null;
    for (const m of p.marks) {
      if (m.type !== 'handles') continue;
      for (const [i, pt] of handlePoints(m.param).entries()) {
        const [x, y] = p.map.px(pt);
        if (Math.hypot(x - q[0], y - q[1]) <= 14) return { param: m.param, index: i };
      }
    }
    return null;
  }

  function setHover(h: string | null) {
    if (h === hover) return;
    hover = h;
    schedule();
  }

  for (const p of panels) {
    p.el.addEventListener('pointermove', (e) => {
      if (drag && drag.panel === p && p.map) {
        const [x, y] = p.map.unpx(local(p, e));
        const v: Vec = [Math.min(Math.max(x, Math.min(...p.spec.x)), Math.max(...p.spec.x)), Math.min(Math.max(y, Math.min(...p.spec.y)), Math.max(...p.spec.y))];
        const spec = specs[drag.param];
        if (spec?.kind === 'point') set({ [drag.param]: v }, true);
        else if (spec?.kind === 'points') {
          const pts = [...(values[drag.param] as Vec[])];
          pts[drag.index] = v;
          set({ [drag.param]: pts }, true);
        }
        return;
      }
      const part = (e.target as Element).closest?.('.viz-tex [class]');
      if (part) {
        const name = [...part.classList].find((c) => !c.startsWith('tml') && c !== 'viz-hot');
        if (name) return setHover(name);
      }
      const q = local(p, e);
      const h = handleAt(p, q);
      const g = h ? `${h.param}:${h.index}` : null;
      if (g !== grab) { grab = g; schedule(); }
      p.canvas.style.cursor = h ? 'grab' : '';
      if (h) return setHover(null);
      const ctx = p.canvas.getContext('2d')!;
      setHover(p.map ? hitTest(p.marks, q, p.map, ctx, theme) : null);
    });
    p.el.addEventListener('pointerleave', () => { if (!drag) { grab = null; setHover(null); } });
    p.canvas.addEventListener('pointerdown', (e) => {
      const h = handleAt(p, local(p, e));
      if (!h) return;
      e.preventDefault();
      p.canvas.setPointerCapture(e.pointerId);
      drag = { panel: p, ...h };
      p.canvas.style.cursor = 'grabbing';
      schedule();
    });
    const end = () => { if (drag?.panel === p) { drag = null; p.canvas.style.cursor = ''; schedule(); } };
    p.canvas.addEventListener('pointerup', end);
    p.canvas.addEventListener('pointercancel', end);
  }

  // --- the page around it ---

  addEventListener('message', (e: MessageEvent<Down>) => {
    if (e.source !== parent || !e.data || typeof e.data !== 'object') return;
    if (e.data.type === 'theme') {
      applyTheme(e.data.mode === 'dark' ? 'dark' : 'light');
      theme = readTheme();
      schedule();
    } else if (e.data.type === 'params' && e.data.params && typeof e.data.params === 'object') {
      values = decodeAll(specs, e.data.params);
      schedule();
    }
  });

  const size = () => post({ source: 'viz', type: 'resize', height: Math.ceil(document.documentElement.getBoundingClientRect().height) });
  new ResizeObserver(() => { schedule(); size(); }).observe(document.documentElement);
  new ResizeObserver(() => schedule()).observe(panelsEl);
  if (clock?.autoplay && !reduceMotion) playing = true;
  schedule();
  post({ source: 'viz', type: 'ready' });
}
