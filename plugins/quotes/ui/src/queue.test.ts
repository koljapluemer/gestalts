import { describe, expect, it } from 'vitest';
import type { FsrsStates, ReviewState } from '@gestalts/learning';
import { clozeFront, clozeParts, levelCount } from './cloze';
import { frontier, pickNext, type Quote } from './queue';

function states(entries: [string, string, string][]): FsrsStates {
  const m = new Map(entries.map(([target, facet, dueAt]) => [`${target}/${facet}`, { lastRating: 3, card: { dueAt } } as ReviewState]));
  const s: FsrsStates = { get: (f) => m.get(`${f.target}/${f.facet}`), has: (f) => m.has(`${f.target}/${f.facet}`), with: () => s };
  return s;
}

const q = (id: string, text: string): Quote => ({ key: id, id, text });
const NOW = new Date('2026-11-04T10:00:00Z');

describe('cloze', () => {
  it('hides words from the end, one per level', () => {
    expect(levelCount(' To be  or not ')).toBe(4);
    expect(clozeParts('To be or not', 1)).toEqual({ visible: 'To be or', hidden: 'not' });
    expect(clozeFront('To be or not', 4)).toBe('＿');
    expect(clozeFront('To be or not', 2)).toBe('To be ＿');
  });
});

describe('queue', () => {
  it('a quote waits at its lowest new or due level', () => {
    const s = states([['a', '1', '2026-12-01T00:00:00Z'], ['a', '2', '2026-11-01T00:00:00Z']]);
    expect(frontier(q('a', 'x y z'), s, NOW)).toMatchObject({ level: 2, status: 'due' });
    expect(frontier(q('a', 'x'), s, NOW)).toBeNull();
  });
  it('prefers due cards, avoids the last quote and favours untouched ones', () => {
    const s = states([['a', '1', '2026-11-01T00:00:00Z'], ['b', '1', '2026-11-01T00:00:00Z']]);
    const quotes = [q('a', 'x'), q('b', 'y'), q('c', 'z')];
    expect(pickNext(quotes, s, NOW, null, new Set(), () => 0)?.status).toBe('due');
    expect(pickNext(quotes, s, NOW, null, new Set(), () => 0.99)?.quote.id).toBe('c');
    expect(pickNext(quotes, s, NOW, 'a', new Set(), () => 0)?.quote.id).toBe('b');
    expect(pickNext(quotes, s, NOW, null, new Set(['a']), () => 0)?.quote.id).toBe('b');
    expect(pickNext([q('a', 'x')], s, NOW, 'a', new Set(), () => 0)?.quote.id).toBe('a');
    expect(pickNext([], s, NOW, null, new Set())).toBeNull();
  });
});
