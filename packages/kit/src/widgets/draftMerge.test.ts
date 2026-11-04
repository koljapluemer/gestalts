import { describe, expect, it } from 'vitest';
import { draftSave, finalCards } from './draftMerge';

// a line-wise stand-in for the core's per-key merge: each line is a key
function merge3(base: string | null, local: string | null, remote: string | null) {
  const [b, l, r] = [base, local, remote].map((t) => (t ?? '').split('\n'));
  let conflict = false;
  const text = l.map((line, i) => {
    if (line === r[i] || r[i] === b[i]) return line;
    if (line === b[i]) return r[i];
    conflict = true;
    return line;
  }).join('\n');
  return { text, conflicts: conflict ? [remote] : [] };
}

describe('draftSave', () => {
  it('writes the draft as it is when nothing changed meanwhile', () => {
    expect(draftSave('a\nb', 'A\nb', 'a\nb', merge3)).toEqual({ kind: 'write', text: 'A\nb' });
  });
  it('merges in a change made meanwhile elsewhere in the note', () => {
    expect(draftSave('a\nb', 'A\nb', 'a\nB', merge3)).toEqual({ kind: 'write', text: 'A\nB' });
  });
  it('stops on the same place changed differently, or the note gone', () => {
    expect(draftSave('a\nb', 'A\nb', 'X\nb', merge3)).toEqual({ kind: 'conflict' });
    expect(draftSave('a\nb', 'A\nb', null, merge3)).toEqual({ kind: 'conflict' });
  });
});

describe('finalCards', () => {
  it('drops empty cards, names new ones by their front, keeps ids unique and existing ids as they are', () => {
    const idOf = (front: string) => `id:${front}`;
    expect(finalCards([
      { id: 'id:a', front: 'a, edited', back: '1' },
      { id: '', front: 'a', back: '2' },
      { id: '', front: ' ', back: '' },
      { id: '', front: 'b', back: '3' },
    ], idOf)).toEqual([
      { id: 'id:a', front: 'a, edited', back: '1' },
      { id: 'id:a-2', front: 'a', back: '2' },
      { id: 'id:b', front: 'b', back: '3' },
    ]);
  });
});
