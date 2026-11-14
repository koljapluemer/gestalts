import { describe, expect, it } from 'vitest';
import { cleanList } from './ListInput';

describe('cleanList', () => {
  it('keeps each entry once, trimmed, in order, case aside', () => {
    expect(cleanList([' a ', 'B', '', 'b', 'A', 'c'])).toEqual(['a', 'B', 'c']);
  });

  it('leaves out what is excluded, like a concept’s own name', () => {
    expect(cleanList(['Gravity', 'pull', 'gravity '], ['gravity'])).toEqual(['pull']);
  });
});
