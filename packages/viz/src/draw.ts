/** Drawing marks on a panel's canvas, and finding the linked mark under the pointer. */
import type { Panel } from './def';
import type { Color, Frame, Mark, Pixels } from './marks';
import { distToSegment, partial, ramp, ticks } from './math';
import type { Vec } from './params';

export type Theme = {
  fg: string; muted: string; accent: string; border: string; surface: string; series: string[];
  font: string; mono: string;
  /** a color as [r, g, b], for scales */
  rgb: (css: string) => [number, number, number];
};

export type Box = { width: number; height: number; top: number; right: number; bottom: number; left: number };

/** The panel's coordinates in px, both ways. */
export function mapping(panel: Panel, box: Box) {
  const [x0, x1] = panel.x, [y0, y1] = panel.y;
  const iw = Math.max(1, box.width - box.left - box.right), ih = Math.max(1, box.height - box.top - box.bottom);
  const sx = iw / (x1 - x0), sy = (panel.yDown ? 1 : -1) * (ih / (y1 - y0));
  const ox = box.left - x0 * sx, oy = panel.yDown ? box.top - y0 * sy : box.top + y1 * (ih / (y1 - y0));
  return {
    px: (p: Vec): Vec => [ox + p[0] * sx, oy + p[1] * sy],
    unpx: (q: Vec): Vec => [(q[0] - ox) / sx, (q[1] - oy) / sy],
    matrix: [sx, 0, 0, sy, ox, oy] as const,
    scale: (Math.abs(sx) + Math.abs(sy)) / 2,
    inner: { x: box.left, y: box.top, w: iw, h: ih },
  };
}
export type Mapping = ReturnType<typeof mapping>;

const THEMED = new Set<string>(['fg', 'muted', 'accent', 'border', 'surface']);

export function colorOf(theme: Theme, c: Color | undefined, fallback: Color = 'fg'): string {
  const v = c ?? fallback;
  if (typeof v === 'number') return theme.series[((v % theme.series.length) + theme.series.length) % theme.series.length];
  return THEMED.has(v) ? theme[v as 'fg'] : v;
}

/** whether `hover` points at this mark (or one of its cells) */
export const isHot = (m: Mark, hover: string | null) => !!(m.link && hover && (hover === m.link || hover.startsWith(`${m.link}:`)));

const images = new WeakMap<object, HTMLCanvasElement>();

function bitmap(key: object, w: number, h: number, fill: (d: Uint8ClampedArray) => void): HTMLCanvasElement {
  let c = images.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    fill(img.data);
    ctx.putImageData(img, 0, 0);
    images.set(key, c);
  }
  return c;
}

const lengths = new Map<string, number>();
function pathLength(d: string): number {
  let l = lengths.get(d);
  if (l === undefined) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    l = p.getTotalLength();
    lengths.set(d, l);
  }
  return l;
}

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(1).replace('-', '−');
  return String(Number(v.toPrecision(6))).replace('-', '−');
}

/** Draws one mark; `hot`: the pointer is over its link. */
export function drawMark(ctx: CanvasRenderingContext2D, m: Mark, map: Mapping, panel: Panel, theme: Theme, hover: string | null, frame: Frame): void {
  const hot = isHot(m, hover);
  const stroke = (c: Color | undefined, fallback: Color = 'fg') => (hot ? theme.accent : colorOf(theme, c, fallback));
  ctx.save();
  ctx.globalAlpha = m.opacity ?? 1;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const lw = (w: number | undefined) => (w ?? 2) + (hot ? 1.5 : 0);
  switch (m.type) {
    case 'point': {
      const [x, y] = map.px(m.at);
      ctx.fillStyle = stroke(m.color);
      ctx.beginPath();
      ctx.arc(x, y, (m.r ?? 4) + (hot ? 1.5 : 0), 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'line':
    case 'arrow': {
      const a = map.px(m.from), b = map.px(m.to);
      ctx.strokeStyle = ctx.fillStyle = stroke(m.color);
      ctx.lineWidth = lw(m.width);
      ctx.setLineDash(m.dash ? [...m.dash] : []);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
      if (m.type === 'arrow') {
        const h = m.head ?? 8, ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(b[0], b[1]);
        ctx.lineTo(b[0] - h * Math.cos(ang - 0.45), b[1] - h * Math.sin(ang - 0.45));
        ctx.lineTo(b[0] - h * Math.cos(ang + 0.45), b[1] - h * Math.sin(ang + 0.45));
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case 'polyline': {
      const pts = (m.draw === undefined ? m.points : partial(m.points, m.draw)).map(map.px);
      if (pts.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
      if (m.closed && m.draw === undefined) ctx.closePath();
      if (m.fill !== undefined) { ctx.fillStyle = hot ? theme.accent : colorOf(theme, m.fill); ctx.fill(); }
      if (m.width !== 0) {
        ctx.strokeStyle = stroke(m.color);
        ctx.lineWidth = lw(m.width);
        ctx.setLineDash(m.dash ? [...m.dash] : []);
        ctx.stroke();
      }
      break;
    }
    case 'path': {
      const p = new Path2D();
      p.addPath(new Path2D(m.d), new DOMMatrix([...map.matrix]));
      if (m.fill !== undefined && (m.draw ?? 1) >= 1) { ctx.fillStyle = hot ? theme.accent : colorOf(theme, m.fill); ctx.fill(p); }
      if (m.width !== 0) {
        ctx.strokeStyle = stroke(m.color);
        ctx.lineWidth = lw(m.width);
        if (m.draw !== undefined && m.draw < 1) {
          const len = pathLength(m.d) * map.scale;
          ctx.setLineDash([Math.max(0, m.draw) * len, len + 1]);
        } else ctx.setLineDash(m.dash ? [...m.dash] : []);
        ctx.stroke(p);
      }
      break;
    }
    case 'rect': {
      const a = map.px(m.at), b = map.px([m.at[0] + m.size[0], m.at[1] + m.size[1]]);
      const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
      if (m.fill !== undefined) { ctx.fillStyle = hot ? theme.accent : colorOf(theme, m.fill); ctx.fillRect(x, y, w, h); }
      if (m.color !== undefined || m.fill === undefined) {
        ctx.strokeStyle = stroke(m.color);
        ctx.lineWidth = lw(m.width);
        ctx.setLineDash(m.dash ? [...m.dash] : []);
        ctx.strokeRect(x, y, w, h);
      }
      break;
    }
    case 'text': {
      const [x, y] = map.px(m.at);
      ctx.fillStyle = stroke(m.color);
      ctx.font = `${m.bold ? '600 ' : ''}${m.size ?? 13}px ${m.mono ? theme.mono : theme.font}`;
      ctx.textAlign = m.align === 'start' ? 'left' : m.align === 'end' ? 'right' : 'center';
      ctx.textBaseline = m.baseline === 'top' ? 'top' : m.baseline === 'bottom' ? 'alphabetic' : 'middle';
      if (m.wrap === undefined) { ctx.fillText(m.text, x, y); break; }
      const lines = wrapLines(ctx, m.text, m.wrap * Math.abs(map.matrix[0]));
      lines.forEach((l, i) => ctx.fillText(l, x, y + i * (m.size ?? 13) * 1.4));
      break;
    }
    case 'raster':
    case 'heatmap': {
      const a = map.px(m.at), b = map.px([m.at[0] + m.size[0], m.at[1] + m.size[1]]);
      const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
      const cols = m.type === 'raster' ? m.image.width : m.cols, rows = m.type === 'raster' ? m.image.height : m.rows;
      const img = m.type === 'raster' ? pixels(m.image) : heat(m.values, cols, rows, m.domain, theme);
      ctx.imageSmoothingEnabled = m.type === 'raster' && !!m.smooth;
      ctx.drawImage(img, x, y, w, h);
      if (hot && hover?.includes(':')) {
        const i = Number(hover.slice(hover.lastIndexOf(':') + 1));
        const cw = w / cols, ch = h / rows;
        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + (i % cols) * cw, y + Math.floor(i / cols) * ch, cw, ch);
      }
      break;
    }
    case 'axis': {
      const { inner } = map;
      ctx.strokeStyle = theme.border;
      ctx.fillStyle = theme.muted;
      ctx.lineWidth = 1;
      ctx.font = `11px ${theme.font}`;
      const f = m.format ?? fmt;
      ctx.beginPath();
      if (m.side === 'bottom') {
        const y = inner.y + inner.h;
        ctx.moveTo(inner.x, y); ctx.lineTo(inner.x + inner.w, y); ctx.stroke();
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        for (const t of ticks(Math.min(...panel.x), Math.max(...panel.x), m.ticks ?? 5)) ctx.fillText(f(t), map.px([t, 0])[0], y + 4);
        if (m.label) { ctx.textAlign = 'end'; ctx.fillText(m.label, inner.x + inner.w, y + 18); }
      } else {
        const x = inner.x;
        ctx.moveTo(x, inner.y); ctx.lineTo(x, inner.y + inner.h); ctx.stroke();
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        for (const t of ticks(Math.min(...panel.y), Math.max(...panel.y), m.ticks ?? 5)) ctx.fillText(f(t), x - 4, map.px([0, t])[1]);
        if (m.label) { ctx.textAlign = 'start'; ctx.textBaseline = 'bottom'; ctx.fillText(m.label, x + 4, inner.y + 10); }
      }
      break;
    }
    case 'custom':
      m.draw(ctx, frame);
      break;
    case 'handles':
    case 'tex':
      break; // drawn by the runtime: handles from their param, tex as HTML
  }
  ctx.restore();
}

function wrapLines(ctx: CanvasRenderingContext2D, s: string, width: number): string[] {
  const out: string[] = [];
  for (const para of s.split('\n')) {
    let cur = '';
    for (const w of para.split(/\s+/)) {
      const next = cur ? `${cur} ${w}` : w;
      if (cur && ctx.measureText(next).width > width) { out.push(cur); cur = w; } else cur = next;
    }
    out.push(cur);
  }
  return out;
}

function pixels(p: Pixels): HTMLCanvasElement {
  return bitmap(p, p.width, p.height, (d) => d.set(p.data));
}

const heats = new WeakMap<object, { canvas: HTMLCanvasElement; theme: Theme }>();
function heat(values: ArrayLike<number | null>, cols: number, rows: number, domain: Vec | undefined, theme: Theme): HTMLCanvasElement {
  const cached = heats.get(values);
  if (cached && cached.theme === theme) return cached.canvas;
  let lo = domain?.[0], hi = domain?.[1];
  if (lo === undefined || hi === undefined) {
    const nums = Array.from(values).filter((v): v is number => v !== null);
    lo = Math.min(0, ...nums); hi = Math.max(lo + 1e-9, ...nums);
  }
  const a = theme.rgb(theme.surface), b = theme.rgb(theme.accent);
  const c = document.createElement('canvas');
  c.width = cols; c.height = rows;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(cols, rows);
  for (let i = 0; i < cols * rows; i++) {
    const v = values[i];
    if (v === null || v === undefined) continue;
    const [r, g, bl] = ramp(a, b, (v - lo) / (hi - lo));
    img.data.set([r, g, bl, 255], i * 4);
  }
  ctx.putImageData(img, 0, 0);
  heats.set(values, { canvas: c, theme });
  return c;
}

/** The link under `q` (px), searching from the top mark down. */
export function hitTest(marks: readonly Mark[], q: Vec, map: Mapping, ctx: CanvasRenderingContext2D, theme: Theme): string | null {
  for (let k = marks.length - 1; k >= 0; k--) {
    const m = marks[k];
    if (!m.link) continue;
    const near = (d: number, w = 2) => d <= w / 2 + 5;
    switch (m.type) {
      case 'point': {
        const p = map.px(m.at);
        if (Math.hypot(p[0] - q[0], p[1] - q[1]) <= (m.r ?? 4) + 5) return m.link;
        break;
      }
      case 'line':
      case 'arrow':
        if (near(distToSegment(q, map.px(m.from), map.px(m.to)), m.width)) return m.link;
        break;
      case 'polyline': {
        const pts = m.points.map(map.px);
        for (let i = 1; i < pts.length; i++) if (near(distToSegment(q, pts[i - 1], pts[i]), m.width)) return m.link;
        break;
      }
      case 'path': {
        const p = new Path2D();
        p.addPath(new Path2D(m.d), new DOMMatrix([...map.matrix]));
        ctx.lineWidth = (m.width ?? 2) + 10;
        if (ctx.isPointInStroke(p, q[0], q[1]) || (m.fill !== undefined && ctx.isPointInPath(p, q[0], q[1]))) return m.link;
        break;
      }
      case 'rect':
      case 'raster':
      case 'heatmap': {
        const a = map.px(m.at), b = map.px([m.at[0] + m.size[0], m.at[1] + m.size[1]]);
        const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
        if (q[0] < x || q[0] >= x + w || q[1] < y || q[1] >= y + h) break;
        if (m.type === 'rect') return m.link;
        const cols = m.type === 'raster' ? m.image.width : m.cols, rows = m.type === 'raster' ? m.image.height : m.rows;
        const i = Math.floor(((q[1] - y) / h) * rows) * cols + Math.floor(((q[0] - x) / w) * cols);
        return `${m.link}:${i}`;
      }
      case 'text': {
        const [x, y] = map.px(m.at);
        ctx.font = `${m.bold ? '600 ' : ''}${m.size ?? 13}px ${m.mono ? theme.mono : theme.font}`;
        const w = ctx.measureText(m.text).width, h = m.size ?? 13;
        const left = m.align === 'start' ? x : m.align === 'end' ? x - w : x - w / 2;
        if (q[0] >= left - 3 && q[0] <= left + w + 3 && Math.abs(q[1] - y) <= h) return m.link;
        break;
      }
      default:
        break;
    }
  }
  return null;
}
