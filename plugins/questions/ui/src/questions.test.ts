import { describe, expect, it } from 'vitest';
import type { IndexedNote, Json } from '@gestalts/sdk';
import { ASK_COUNT, QUESTIONS, fallback, idsIn, isCandidate, pickRequest, randomKey } from './questions';

const note = (value: Json): IndexedNote => ({ key: 'k', id: 'k', raw: '', value, parse_error: null, gestalts: [], lints: [] });

describe('isCandidate', () => {
  it('wants a statement in main', () => {
    expect(isCandidate(note({ main: 'habits > goals' }))).toBe(true);
    expect(isCandidate(note({ main: 'roughly ~ the same' }))).toBe(true);
    expect(isCandidate(note({ main: 'just a thought' }))).toBe(false);
    expect(isCandidate(note({ title: 'a > b' }))).toBe(false);
  });

  it('wants at most one relationship, not counting inline links', () => {
    expect(isCandidate(note({ main: 'a > b', relationships: ['x'] }))).toBe(true);
    expect(isCandidate(note({ main: 'a > b', relationships: ['x', { to: 'y', label: 'solves' }] }))).toBe(false);
    expect(isCandidate(note({ main: 'a > b [[y]] [[z]]', relationships: ['x', { to: 'y', label: 'inline' }, { to: 'z', label: 'inline' }] }))).toBe(true);
  });
});

describe('idsIn', () => {
  it('reads the JSON reply, keeping known ids in order, at most ASK_COUNT', () => {
    expect(idsIn('{"ids": ["so-what", "nope", "assumes"]}')).toEqual(['so-what', 'assumes']);
    expect(idsIn('{"ids": ["solves", "assumes", "matters", "testable"]}')).toHaveLength(ASK_COUNT);
    expect(idsIn('{"ids": []}')).toEqual([]);
  });

  it('finds ids in prose, the longest first', () => {
    expect(idsIn('I would pick does-not-solve and then solves.')).toEqual(['does-not-solve', 'solves']);
    expect(idsIn('```json\n{"ids": ["leads-to"]\n```')).toEqual(['leads-to']);
  });

  it('throws on a reply naming none', () => {
    expect(() => idsIn('I cannot help with that.')).toThrow(/unexpected reply/);
  });
});

describe('the rest', () => {
  it('lists every question in the request', () => {
    const r = pickRequest('a > b');
    for (const q of QUESTIONS) expect(r).toContain(`- ${q.id}: ${q.question}`);
  });

  it('falls back to the first questions', () => {
    expect(fallback().map((q) => q.id)).toEqual(QUESTIONS.slice(0, ASK_COUNT).map((q) => q.id));
  });

  it('draws a key not to avoid when there is one', () => {
    expect(randomKey(['a', 'b'], new Set(['a']), () => 0)).toBe('b');
    expect(randomKey(['a'], new Set(['a']))).toBe('a');
    expect(randomKey([], new Set())).toBeNull();
  });
});
