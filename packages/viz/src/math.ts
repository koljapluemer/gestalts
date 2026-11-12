/** Small pure helpers a model or the runtime needs, so vizzes don't each write their own. */
import type { Vec } from './params';

/** A seeded random number generator (mulberry32): the same seed gives the same numbers, so a model stays pure. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Every state of a simulation, from `init` by `steps` calls of `step` (each `dt` apart): a model computes the whole
 * run, and the clock picks where in it to look. Pass randomness in as `rng(seed)` to keep it pure.
 */
export function trajectory<S>(init: S, step: (s: S, dt: number, i: number) => S, steps: number, dt = 1): S[] {
  const out: S[] = [init];
  let s = init;
  for (let i = 0; i < steps; i++) {
    s = step(s, dt, i);
    out.push(s);
  }
  return out;
}

/** One classic Runge–Kutta step of `dy/dt = f(y)` for a vector `y`. */
export function rk4(f: (y: readonly number[]) => number[], y: readonly number[], dt: number): number[] {
  const add = (a: readonly number[], b: readonly number[], k: number) => a.map((v, i) => v + b[i] * k);
  const k1 = f(y);
  const k2 = f(add(y, k1, dt / 2));
  const k3 = f(add(y, k2, dt / 2));
  const k4 = f(add(y, k3, dt));
  return y.map((v, i) => v + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const lerpVec = (a: Vec, b: Vec, t: number): Vec => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Whether `a` and `b` (numbers, or arrays of them, nested) agree to within `eps`: for `checks`. */
export function near(a: unknown, b: unknown, eps = 1e-9): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => near(x, b[i], eps));
  return false;
}

/** About `count` round numbers spanning `lo`..`hi`. */
export function ticks(lo: number, hi: number, count = 5): number[] {
  if (!(hi > lo) || count < 1) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

export function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2, 0, 1) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** The first `fraction` (0..1) of a polyline, by length. */
export function partial(pts: readonly Vec[], fraction: number): Vec[] {
  if (fraction >= 1 || pts.length < 2) return [...pts];
  if (fraction <= 0) return pts.slice(0, 1);
  const lens = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
  let left = lens.reduce((a, b) => a + b, 0) * fraction;
  const out: Vec[] = [pts[0]];
  for (let i = 0; i < lens.length; i++) {
    if (left >= lens[i]) { out.push(pts[i + 1]); left -= lens[i]; continue; }
    out.push(lerpVec(pts[i], pts[i + 1], lens[i] ? left / lens[i] : 0));
    break;
  }
  return out;
}

/** A color for `t` (0..1) on a sequential scale from the surface color to `hi`, as an [r, g, b]. */
export function ramp(lo: readonly number[], hi: readonly number[], t: number): [number, number, number] {
  const c = clamp(t, 0, 1);
  return [lerp(lo[0], hi[0], c), lerp(lo[1], hi[1], c), lerp(lo[2], hi[2], c)];
}
