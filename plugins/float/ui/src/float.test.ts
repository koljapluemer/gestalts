import { describe, expect, it } from 'vitest';
import { draw, flight, MAX_S, MIN_S } from './float';

describe('draw', () => {
  it('picks distinct keys, at most n', () => {
    const keys = Array.from({ length: 30 }, (_, i) => `k${i}`);
    const got = draw(keys, 20);
    expect(got).toHaveLength(20);
    expect(new Set(got).size).toBe(20);
  });

  it('gives all there are when fewer than n', () => {
    expect(draw(['a', 'b'], 20, () => 0).sort()).toEqual(['a', 'b']);
    expect(draw([], 20)).toEqual([]);
  });
});

describe('flight', () => {
  it('starts within the stage and takes between MIN_S and MAX_S', () => {
    expect(flight(0, 0)).toEqual({ top: '10%', duration: MIN_S });
    const f = flight(0.999, 0.999);
    expect(parseFloat(f.top)).toBeLessThan(70);
    expect(f.duration).toBeLessThan(MAX_S);
  });
});
