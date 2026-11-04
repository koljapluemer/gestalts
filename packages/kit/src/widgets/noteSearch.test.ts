import { describe, expect, it } from 'vitest';
import type { IndexedNote } from '@gestalts/sdk';
import { buildIndex, parseQuery, search } from './noteSearch';

function note(key: string, value: Record<string, unknown>, gestalts: string[] = []): IndexedNote {
  const raw = Object.entries(value).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
  return { key, id: key, raw, value: value as IndexedNote['value'], parse_error: null, gestalts, lints: [] };
}

const notes = [
  note('a', { title: 'δελφίς', tags: ['greek-alphabet'] }, ['pronunciation-card@1']),
  note('b', { title: 'Delphi trip', main: 'visit the oracle' }),
  note('c', { title: 'Oracle notes', main: 'delphi again', tags: ['travel'] }),
  note('d', { title: 'Unrelated', main: 'nothing here' }),
];
const index = buildIndex(notes);
const keys = (q: string, tags?: string[]) => search(index, q, tags).notes.map((n) => n.key);

describe('search', () => {
  it('matches every word as word or prefix, ignoring accents and case', () => {
    expect(keys('δελ')).toEqual(['a']);
    expect(keys('δελφις')).toEqual(['a']);
    expect(keys('DELPH')).toEqual(['b', 'c']);
    expect(keys('delphi oracle').sort()).toEqual(['b', 'c']);
    expect(keys('delphi zebra')).toEqual([]);
  });

  it('ranks title matches above main matches', () => {
    expect(keys('oracle')).toEqual(['c', 'b']);
    expect(keys('delphi')).toEqual(['b', 'c']);
  });

  it('filters by tag, gestalt and exclusion', () => {
    expect(keys('#travel')).toEqual(['c']);
    expect(keys('tag:greek-alphabet')).toEqual(['a']);
    expect(keys('gestalt:pronunciation-card@1')).toEqual(['a']);
    expect(keys('delphi -oracle')).toEqual([]);
    expect(keys('', ['travel'])).toEqual(['c']);
  });

  it('lists everything by label for an empty query', () => {
    expect(keys('')).toEqual(['b', 'c', 'd', 'a']);
  });

  it('parses queries', () => {
    expect(parseQuery('#a tag:b gestalt:x@1 -no yes')).toEqual({ terms: ['yes'], exclude: ['no'], tags: ['a', 'b'], gestalts: ['x@1'] });
  });
});
