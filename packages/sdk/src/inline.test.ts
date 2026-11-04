import { describe, expect, it } from 'vitest';
import { inlineOutOfSync, inlineRefs, syncInline, type RefsOf } from './inline';

// enough of the Markdown parser for these tests
const refsOf: RefsOf = (t) => [...t.matchAll(/(!?)\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((m) => ({ target: m[2], embed: m[1] === '!' }));

describe('syncInline', () => {
  it('adds a relationship per reference, in order, and lists embeds in blobs', () => {
    const v = syncInline({ id: 'n', main: 'See [[b]] and [[a|A]], again [[b]]. ![[x.webp]]', blobs: [{ file: 'y.webp', label: 'image' }] }, refsOf);
    expect(v.relationships).toEqual([{ to: 'b', label: 'inline' }, { to: 'a', label: 'inline' }]);
    expect(v.blobs).toEqual([{ file: 'y.webp', label: 'image' }, 'x.webp']);
  });

  it('keeps other relationships and existing inline ones in place, drops gone ones', () => {
    const v = syncInline({
      main: '[[a]] [[c]]',
      relationships: ['p', { to: 'b', label: 'inline' }, { to: 'a', label: 'inline' }, { to: 'b', label: 'cites' }],
    }, refsOf);
    expect(v.relationships).toEqual(['p', { to: 'a', label: 'inline' }, { to: 'b', label: 'cites' }, { to: 'c', label: 'inline' }]);
  });

  it('reads extra and cards, skips the note itself, never drops blobs', () => {
    const v = syncInline({
      id: 'me', extra: '[[me]] [[e]]', cards: [{ id: '1', front: '![[f.png]]', back: '[[k]]' }], blobs: ['old.png'],
    }, refsOf);
    expect(v.relationships).toEqual([{ to: 'e', label: 'inline' }, { to: 'k', label: 'inline' }]);
    expect(v.blobs).toEqual(['old.png', 'f.png']);
  });

  it('removes the key once its last inline relationship is gone, and is idempotent', () => {
    expect(syncInline({ main: 'none', relationships: [{ to: 'a', label: 'inline' }] }, refsOf)).toEqual({ main: 'none' });
    const once = syncInline({ main: '[[a]] ![[b.png]]' }, refsOf);
    expect(syncInline(once, refsOf)).toEqual(once);
    expect(inlineOutOfSync(once, refsOf)).toBe(false);
    expect(inlineOutOfSync({ main: '[[a]]' }, refsOf)).toBe(true);
    expect(inlineOutOfSync({ main: 'plain' }, refsOf)).toBe(false);
  });

  it('lists targets and embeds once', () => {
    expect(inlineRefs({ main: '[[a]] ![[x.png]] [[a]]' }, refsOf)).toEqual({ targets: ['a'], embeds: ['x.png'] });
  });
});
