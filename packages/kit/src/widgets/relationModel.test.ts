import { describe, expect, it } from 'vitest';
import type { IndexedNote, Json } from '@gestalts/sdk';
import { addRelation, buildBacklinks, relabelRelation, removeRelation, rowsOf } from './relationModel';

const note = (key: string, value: { [k: string]: Json }): IndexedNote =>
  ({ key, id: key, raw: JSON.stringify(value), value: { id: key, ...value }, parse_error: null, gestalts: [], lints: [] });
const refsOf = (t: string) => [...t.matchAll(/(!?)\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((m) => ({ target: m[2], embed: m[1] === '!' }));
const keyOf = (id: string) => (['a', 'b', 'c'].includes(id) ? id : undefined);

describe('backlinks', () => {
  const notes = [
    note('a', { main: 'see [[b]] and [[b|B]], ![[b]]', relationships: [{ to: 'b', label: 'inline' }, { to: 'b', label: 'cites' }, 'b', 'gone'] }),
    note('c', { extra: '[[b]] [[c]]', tags: ['x'] }),
    note('old', { main: '[[b]]', tags: ['retired'] }),
  ];
  const index = buildBacklinks(notes, keyOf, refsOf);

  it('lists explicit and inline links once per source, skipping self links, missing targets and retired notes', () => {
    expect(index.get('b')).toEqual([
      { from: 'a', via: 'b', label: null, inline: true },
      { from: 'a', via: 'b', label: 'cites', inline: false },
      { from: 'a', via: 'b', label: null, inline: false },
      { from: 'c', via: 'b', label: null, inline: true },
    ]);
    expect(index.has('c')).toBe(false);
  });

  it('makes rows: explicit out, inline out (from text and relationships), then backlinks', () => {
    const a = notes[0];
    expect(rowsOf(a, [], keyOf, refsOf)).toEqual([
      { dir: 'out', label: 'cites', other: 'b', otherKey: 'b', inline: false },
      { dir: 'out', label: null, other: 'b', otherKey: 'b', inline: false },
      { dir: 'out', label: null, other: 'gone', otherKey: undefined, inline: false },
      { dir: 'out', label: null, other: 'b', otherKey: 'b', inline: true },
    ]);
    expect(rowsOf(notes[1], index.get('b') ?? [], keyOf, refsOf).map((r) => `${r.dir} ${r.other} ${r.inline}`)).toContain('in a true');
  });
});

describe('relation edits', () => {
  it('adds once, unlabelled as a plain id', () => {
    const v = addRelation({ id: 'n' }, 'x', ' ');
    expect(v.relationships).toEqual(['x']);
    expect(addRelation(v, 'x', null)).toBe(v);
    expect(addRelation(v, 'x', 'cites').relationships).toEqual(['x', { to: 'x', label: 'cites' }]);
  });

  it('removes the first match and drops an empty list', () => {
    expect(removeRelation({ relationships: ['x', { to: 'x', label: 'l' }] }, 'x', 'l')).toEqual({ relationships: ['x'] });
    expect(removeRelation({ relationships: ['x'] }, 'x', null)).toEqual({});
  });

  it('relabels in place, keeping other keys, and merges into an existing one', () => {
    expect(relabelRelation({ relationships: ['y', 'x'] }, 'x', null, 'l')).toEqual({ relationships: ['y', { to: 'x', label: 'l' }] });
    expect(relabelRelation({ relationships: [{ to: 'x', label: 'l', note: 1 }] }, 'x', 'l', '')).toEqual({ relationships: [{ to: 'x', note: 1 }] });
    expect(relabelRelation({ relationships: [{ to: 'x', label: 'l' }] }, 'x', 'l', null)).toEqual({ relationships: ['x'] });
    expect(relabelRelation({ relationships: ['x', { to: 'x', label: 'l' }] }, 'x', null, 'l')).toEqual({ relationships: [{ to: 'x', label: 'l' }] });
  });
});
