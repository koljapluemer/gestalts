/**
 * Keyed marks moving between states. The scene says where things are; a mark with a `key` and a `transition` gets
 * there smoothly from wherever it was drawn last: every number in it (and in arrays of the same length) is
 * interpolated. New keys fade in, keys that disappear fade out.
 */
import type { Mark } from './marks';

type Entry = { from: Mark; to: Mark; start: number; dur: number; sig: string; leaving: boolean };

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** a's and b's numbers mixed by t, everything else b's */
export function mix<T>(a: T, b: T, t: number): T {
  if (typeof a === 'number' && typeof b === 'number') return (a + (b - a) * t) as T;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return b.map((x, i) => mix(a[i], x, t)) as T;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(b) && !ArrayBuffer.isView(b)) {
    const out: Record<string, unknown> = { ...(b as Record<string, unknown>) };
    for (const k of Object.keys(out)) out[k] = mix((a as Record<string, unknown>)[k], out[k], t);
    return out as T;
  }
  return b;
}

/** what a mark looks like, cheaply: big arrays by length, functions not at all */
function signature(m: Mark): string {
  return JSON.stringify(m, (_k, v) => (ArrayBuffer.isView(v) ? `#${(v as Uint8Array).length}` : typeof v === 'function' ? undefined : v));
}

const keyed = (m: Mark): m is Mark & { key: string; transition: number } => typeof m.key === 'string' && (m.transition ?? 0) > 0;

export class Tweens {
  private entries = new Map<string, Entry>();

  /** whether anything is still moving: the runtime keeps drawing while it is */
  get active(): boolean {
    return this.entries.size > 0 && [...this.entries.values()].some((e) => e.leaving || e.start + e.dur > this.last);
  }

  private last = 0;

  private at(e: Entry, now: number): Mark {
    const t = e.dur > 0 ? Math.min(1, Math.max(0, (now - e.start) / e.dur)) : 1;
    return t >= 1 ? e.to : mix(e.from, e.to, ease(t));
  }

  /** The marks to draw at `now` (ms), for the scene's latest `marks`. */
  frame(marks: readonly Mark[], now: number): Mark[] {
    this.last = now;
    const out: Mark[] = [];
    const seen = new Set<string>();
    for (const given of marks) {
      if (!keyed(given)) { out.push(given); continue; }
      // a fade needs an opacity to start from and go to
      const m = { ...given, opacity: given.opacity ?? 1 };
      seen.add(m.key);
      const sig = signature(m);
      const e = this.entries.get(m.key);
      if (!e) {
        const entry = { from: { ...m, opacity: 0 }, to: m, start: now, dur: m.transition, sig, leaving: false };
        this.entries.set(m.key, entry);
        out.push(this.at(entry, now));
      } else if (e.sig !== sig || e.leaving) {
        const entry = { from: this.at(e, now), to: m, start: now, dur: m.transition, sig, leaving: false };
        this.entries.set(m.key, entry);
        out.push(this.at(entry, now));
      } else {
        e.to = m; // same look: keep moving toward it, with the scene's latest functions and arrays
        out.push(this.at(e, now));
      }
    }
    for (const [key, e] of this.entries) {
      if (seen.has(key)) continue;
      if (!e.leaving) {
        const from = this.at(e, now);
        const left = { from, to: { ...from, opacity: 0 }, start: now, dur: e.dur, sig: '', leaving: true };
        this.entries.set(key, left);
        out.push(this.at(left, now));
      } else if (now - e.start >= e.dur) {
        this.entries.delete(key);
      } else {
        out.push(this.at(e, now));
      }
    }
    return out;
  }
}
