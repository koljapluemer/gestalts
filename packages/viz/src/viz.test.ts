import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runVizChecks } from '../build/build';
import { line, text } from './marks';
import { near, partial, rk4, ticks, trajectory } from './math';
import { choice, decode, decodeAll, encode, encodeAll, point, points, range, toggle } from './params';
import { Tweens, mix } from './tween';

describe('params', () => {
  const specs = {
    t: range(0, 1, 0.5, { step: 0.01 }),
    on: toggle(false),
    mode: choice(['a', 'b'] as const, 'a'),
    p: point([0.1, 0.2]),
    ps: points([[0, 0], [1, 1]]),
  };

  it('encodes and decodes every kind', () => {
    for (const spec of Object.values(specs)) expect(decode(spec, encode(spec, spec.value))).toEqual(spec.value);
    expect(encode(specs.ps, [[0.3, 1], [0.7, 0.25]])).toBe('0.3,1;0.7,0.25');
  });

  it('keeps only what differs from the defaults in a link, and ignores what is invalid in one', () => {
    expect(encodeAll(specs, { ...decodeAll(specs, {}), t: 0.25 })).toEqual({ t: '0.25' });
    const v = decodeAll(specs, { t: '7', mode: 'z', on: '1', p: 'x,1', nope: '1' });
    expect(v.t).toBe(1); // clamped
    expect(v.mode).toBe('a');
    expect(v.on).toBe(true);
    expect(v.p).toEqual([0.1, 0.2]);
  });

  it('snaps a range to its step', () => {
    expect(decode(specs.t, '0.123')).toBeCloseTo(0.12, 10);
  });
});

describe('math', () => {
  it('finds round ticks', () => {
    expect(ticks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(ticks(0, 1, 4)).toEqual([0, 0.5, 1]);
    expect(ticks(-3, 3, 3)).toEqual([-2, 0, 2]);
  });

  it('cuts a polyline by length', () => {
    expect(partial([[0, 0], [1, 0], [1, 1]], 0.75)).toEqual([[0, 0], [1, 0], [1, 0.5]]);
    expect(partial([[0, 0], [2, 0]], 0)).toEqual([[0, 0]]);
  });

  it('integrates exponential growth with rk4', () => {
    const run = trajectory<number[]>([1], (s) => rk4(([y]) => [y], s, 0.01), 100);
    expect(near(run[100][0], Math.E, 1e-8)).toBe(true);
  });
});

describe('transitions', () => {
  it('mixes numbers, same-length arrays and objects, and takes the rest from the target', () => {
    expect(mix({ at: [0, 0], s: 'a', n: 0 }, { at: [2, 4], s: 'b', n: 10 }, 0.5)).toEqual({ at: [1, 2], s: 'b', n: 5 });
    expect(mix([1, 2], [3, 4, 5], 0.5)).toEqual([3, 4, 5]);
  });

  it('moves a keyed mark from where it was drawn, fades new ones in and old ones out', () => {
    const tw = new Tweens();
    const a = (x: number) => line([x, 0], [x, 1], { key: 'a', transition: 100 });
    const first = tw.frame([a(0)], 0)[0];
    expect(first.opacity).toBe(0);
    expect(tw.frame([a(0)], 100)[0]).toMatchObject({ from: [0, 0], opacity: 1 });
    const mid = tw.frame([a(10)], 100)[0] as ReturnType<typeof a>;
    expect(mid.from[0]).toBe(0);
    const half = tw.frame([a(10)], 150)[0] as ReturnType<typeof a>;
    expect(half.from[0]).toBeGreaterThan(0);
    expect(half.from[0]).toBeLessThan(10);
    expect((tw.frame([a(10)], 200)[0] as ReturnType<typeof a>).from[0]).toBe(10);
    const leaving = tw.frame([], 200);
    expect(leaving).toHaveLength(1);
    expect(tw.frame([], 400)).toHaveLength(0);
    expect(tw.active).toBe(false);
  });

  it('passes unkeyed marks through untouched', () => {
    const m = text([0, 0], 'x');
    expect(new Tweens().frame([m], 0)[0]).toBe(m);
  });
});

describe('the examples', () => {
  const dir = join(import.meta.dirname, '../examples');
  for (const name of readdirSync(dir)) {
    it(`${name} passes its checks`, async () => {
      const results = await runVizChecks(join(dir, name));
      expect(results.filter((r) => !r.ok)).toEqual([]);
      expect(results.length).toBeGreaterThan(1);
    }, 30_000);
  }
});
