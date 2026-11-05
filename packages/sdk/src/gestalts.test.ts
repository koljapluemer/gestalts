import { describe, expect, it } from 'vitest';
import { noteGestalts, seedFor } from './gestalts';
import type { GestaltDef } from './types';

const def = (name: string, requires_tags: string[]): GestaltDef => ({
  name, version: 1, description: null, requires_tags, trigger_fields: [], fields: {}, blobs: {}, relationships: {},
});

describe('noteGestalts', () => {
  it('lists the gestalts a note has, then each one it is a candidate for, once', () => {
    const lint = (gestalt: string) => ({ gestalt, path: 'x', message: 'm' });
    expect(noteGestalts({ gestalts: ['a@1'], lints: [lint('b@1'), lint('b@1'), lint('c@2')] }))
      .toEqual([{ id: 'a@1', has: true }, { id: 'b@1', has: false }, { id: 'c@2', has: false }]);
  });
});

describe('seedFor', () => {
  it('adds the tags the gestalt requires after the ones given', () => {
    expect(seedFor(def('appointment', ['appointment']), { title: 'x', tags: ['work'] })).toEqual({ title: 'x', tags: ['work', 'appointment'] });
  });
  it('keeps a tag given already once, and a single tag string as a list', () => {
    expect(seedFor(def('q', ['quote']), { tags: 'quote' })).toEqual({ tags: ['quote'] });
  });
  it('adds no tags for a gestalt without any', () => {
    expect(seedFor(def('link', []), { url: 'u' })).toEqual({ url: 'u' });
  });
});
