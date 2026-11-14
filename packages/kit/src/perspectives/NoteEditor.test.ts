import { describe, expect, it } from 'vitest';
import { patched } from './NoteEditor';
import { noteHeadline } from '../widgets/NoteTitle';

describe('patched', () => {
  it('sets what has something in it and leaves out what was emptied', () => {
    const base = { id: 'n', gestalt: 'note@1', title: 'Old', main: 'text', tags: ['x'] };
    expect(patched(base, { title: '  New  ', main: '  ', tags: [], aliases: ['a'] })).toEqual({ id: 'n', gestalt: 'note@1', title: 'New', aliases: ['a'] });
  });

  it('keeps every prop it isn’t told about', () => {
    expect(patched({ id: 'n', gestalt: 'note@1', extra: 'e', blobs: [{ file: 'f', label: 'l' }] }, { main: 'm' }))
      .toEqual({ id: 'n', gestalt: 'note@1', extra: 'e', blobs: [{ file: 'f', label: 'l' }], main: 'm' });
  });
});

describe('noteHeadline', () => {
  it('is the title, else the first line of main that says something, without its block marker', () => {
    expect(noteHeadline({ title: ' T ', main: 'm' })).toBe('T');
    expect(noteHeadline({ main: '\n\n## A *heading*\nmore' })).toBe('A *heading*');
    expect(noteHeadline({ main: '- [ ] a task' })).toBe('a task');
    expect(noteHeadline({ main: '1. first' })).toBe('first');
    expect(noteHeadline({})).toBe('');
  });
});
