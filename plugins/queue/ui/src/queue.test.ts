import { describe, expect, it } from 'vitest';
import { draw, withTag } from './queue';

describe('draw', () => {
  it('picks distinct keys, at most n', () => {
    const keys = ['a', 'b', 'c', 'd', 'e'];
    for (let i = 0; i < 20; i++) {
      const got = draw(keys, 3);
      expect(got).toHaveLength(3);
      expect(new Set(got).size).toBe(3);
      for (const k of got) expect(keys).toContain(k);
    }
  });

  it('gives all there are when fewer than n', () => {
    expect(draw(['a', 'b'], 3, () => 0).sort()).toEqual(['a', 'b']);
    expect(draw([], 3)).toEqual([]);
  });

  it('follows the random source', () => {
    expect(draw(['a', 'b', 'c', 'd'], 2, () => 0)).toEqual(['a', 'b']);
    expect(draw(['a', 'b', 'c', 'd'], 2, () => 0.99)).toEqual(['d', 'a']);
  });
});

describe('withTag', () => {
  it('adds the tag after the others', () => {
    expect(withTag({ title: 'x', tags: ['a'] }, 'no-q', true)).toEqual({ title: 'x', tags: ['a', 'no-q'] });
    expect(withTag({ title: 'x' }, 'no-q', true)).toEqual({ title: 'x', tags: ['no-q'] });
    expect(withTag({ tags: 'a' }, 'no-q', true)).toEqual({ tags: ['a', 'no-q'] });
  });

  it('removes it, keeping the order', () => {
    expect(withTag({ tags: ['a', 'no-q', 'b'] }, 'no-q', false)).toEqual({ tags: ['a', 'b'] });
  });

  it('changes nothing when already so', () => {
    const v = { tags: ['no-q'] };
    expect(withTag(v, 'no-q', true)).toBe(v);
    expect(withTag({ tags: ['a'] }, 'no-q', false)).toEqual({ tags: ['a'] });
  });
});
