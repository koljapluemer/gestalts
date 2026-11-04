import { describe, expect, it } from 'vitest';
import { pathLabel, resolveConflict, setAt, type ConflictRecord } from './conflicts';
import type { IndexedNote, Json } from './types';

describe('setAt', () => {
  it('sets keys and list items by id', () => {
    expect(setAt({ a: 1 }, ['b', 'c'], 2)).toEqual({ a: 1, b: { c: 2 } });
    expect(setAt({ cards: [{ id: 'x', front: 'a' }] }, ['cards', { by: 'id', id: 'x' }, 'front'], 'b')).toEqual({ cards: [{ id: 'x', front: 'b' }] });
    expect(setAt({ cards: [] }, ['cards', { by: 'id', id: 'y' }], { id: 'y', front: 'n' })).toEqual({ cards: [{ id: 'y', front: 'n' }] });
    expect(setAt({ a: 1, b: 2 }, ['b'], undefined)).toEqual({ a: 1 });
  });
  it('labels paths', () => {
    expect(pathLabel(['cards', { by: 'id', id: 'x' }, 'front'])).toBe('cards[x].front');
    expect(pathLabel([])).toBe('the whole note');
  });
});

describe('resolveConflict', () => {
  const fake = () => {
    const notes = new Map<string, Json>([['n', { a: 3 }], ['c', { note: 'n' }]]);
    const repo = {
      query: () => [],
      get: (key: string) => (notes.has(key) ? ({ key, value: notes.get(key) } as IndexedNote) : undefined),
      putRaw: async (key: string, raw: string) => { notes.set(key, raw); },
      putValue: async (key: string | undefined, value: Json) => { notes.set(key!, value); },
      delete: async (key: string) => { notes.delete(key); },
    };
    return { notes, repo };
  };
  const c: ConflictRecord = { key: 'c', note: 'n', path: ['a'], base: 1, kept: 3, lost: 2, raw: false, recorded: '' };

  it('keeping the kept side only removes the record', async () => {
    const { notes, repo } = fake();
    await resolveConflict(repo, c, { take: 'kept' });
    expect(notes.get('n')).toEqual({ a: 3 });
    expect(notes.has('c')).toBe(false);
  });
  it('taking the lost side writes it at the path', async () => {
    const { notes, repo } = fake();
    await resolveConflict(repo, c, { take: 'lost' });
    expect(notes.get('n')).toEqual({ a: 2 });
  });
  it('restores a deleted note', async () => {
    const { notes, repo } = fake();
    await resolveConflict(repo, { ...c, path: [], kept: { id: 'n', deleted: 'x' }, lost: { title: 'back' } }, { take: 'lost' });
    expect(notes.get('n')).toEqual({ title: 'back' });
  });
});
