import { describe, expect, it } from 'vitest';
import { applyTextDraft, textFields, textUneditable } from './noteText';

describe('text drafts', () => {
  const base = { title: 'T', main: 'old', extra: '' };

  it('sets the changed fields on the note as it is now, keeps the rest, syncs inline references', () => {
    const current = { id: 'n', title: 'T', main: 'old', tags: ['x'], extra: 'changed elsewhere' };
    const r = applyTextDraft(current, { ...base, extra: '' }, { ...base, main: 'see [[m]]', extra: '' });
    expect(r).toEqual({ kind: 'write', value: { ...current, main: 'see [[m]]', relationships: [{ to: 'm', label: 'inline' }] } });
  });

  it('removes emptied fields and keeps titles on one line', () => {
    const r = applyTextDraft({ title: 'T', main: 'old' }, base, { title: ' a\nb ', main: '', extra: '' });
    expect(r).toEqual({ kind: 'write', value: { title: 'a b' } });
  });

  it('stops when the same field changed meanwhile, unless forced', () => {
    const current = { title: 'T', main: 'theirs' };
    expect(applyTextDraft(current, base, { ...base, main: 'mine' })).toEqual({ kind: 'conflict' });
    expect(applyTextDraft(current, base, { ...base, main: 'theirs' })).toEqual({ kind: 'write', value: current });
    expect(applyTextDraft(current, base, { ...base, main: 'mine' }, true)).toEqual({ kind: 'write', value: { title: 'T', main: 'mine' } });
  });

  it('reads and checks the fields', () => {
    expect(textFields({ main: 'm', extra: 3 })).toEqual({ title: '', main: 'm', extra: '' });
    expect(textUneditable({ extra: 3 })).toBe('extra isn\'t text');
    expect(textUneditable(null)).not.toBeNull();
    expect(textUneditable({ main: 'x' })).toBeNull();
  });
});
