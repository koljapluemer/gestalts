import { describe, expect, it } from 'vitest';
import { applyValueDraft, normalize, patched } from './valueDraft';

describe('applyValueDraft', () => {
  const base = { id: 'n', title: 'T', main: 'text', tags: ['a'] };

  it('sets the fields the draft changed and keeps the note\'s others as they are now', () => {
    const current = { ...base, extra: 'added elsewhere' };
    expect(applyValueDraft(current, base, { ...base, main: 'new', date: '2026-11-05' }))
      .toEqual({ kind: 'write', value: { ...current, main: 'new', date: '2026-11-05' }, changed: ['main', 'date'] });
  });

  it('takes emptied fields off', () => {
    expect(applyValueDraft(base, base, { ...base, main: '  ', tags: [] }))
      .toEqual({ kind: 'write', value: { id: 'n', title: 'T' }, changed: ['main', 'tags'] });
  });

  it('stops when the note changed a drafted field meanwhile, unless forced', () => {
    const current = { ...base, main: 'synced' };
    const draft = { ...base, main: 'mine' };
    expect(applyValueDraft(current, base, draft)).toEqual({ kind: 'conflict', keys: ['main'] });
    expect(applyValueDraft(current, base, draft, true)).toMatchObject({ kind: 'write', value: { main: 'mine' } });
  });

  it('is no conflict when both made the same change', () => {
    const current = { ...base, main: 'same' };
    expect(applyValueDraft(current, base, { ...base, main: 'same' })).toEqual({ kind: 'write', value: current, changed: [] });
  });

  it('writes a title on one line', () => {
    expect(applyValueDraft(base, base, { ...base, title: ' A\n  title ' })).toMatchObject({ value: { title: 'A title' } });
  });
});

describe('normalize and patched', () => {
  it('keeps zero, false and null', () => {
    expect(normalize('n', 0)).toBe(0);
    expect(normalize('b', false)).toBe(false);
    expect(normalize('x', null)).toBeNull();
  });
  it('patches, taking off what is patched to undefined', () => {
    expect(patched({ a: 1, b: 2 }, { b: undefined, c: 3 })).toEqual({ a: 1, c: 3 });
  });
});
