import { describe, expect, it } from 'vitest';
import { share } from './share';

describe('share', () => {
  it('keeps the parts that are equal', () => {
    const f = () => {};
    const prev = { a: { x: 1 }, b: [{ y: 2 }, { y: 3 }], f };
    const next = share(prev, { a: { x: 1 }, b: [{ y: 2 }, { y: 4 }], f });
    expect(next.a).toBe(prev.a);
    expect(next.b[0]).toBe(prev.b[0]);
    expect(next.b[1]).toEqual({ y: 4 });
    expect(next).not.toBe(prev);
    expect(share(prev, { a: { x: 1 }, b: [{ y: 2 }, { y: 3 }], f })).toBe(prev);
  });

  it('compares functions by identity, and drops removed keys', () => {
    const prev = { f: () => {}, g: 1 };
    expect(share(prev, { f: () => {}, g: 1 })).not.toBe(prev);
    expect(share({ a: 1, b: 2 } as Record<string, number>, { a: 1 })).toEqual({ a: 1 });
  });
});
