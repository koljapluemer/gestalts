import { describe, expect, it } from 'vitest';
import type { NoteSeed } from '@gestalts/sdk';
import { decodeOverlay, encodeOverlay, type Overlay } from './overlay';

const roundTrip = (o: Overlay | null) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(encodeOverlay(o))) if (v !== null) params.set(k, v);
  return decodeOverlay(params);
};

describe('overlay in the URL', () => {
  it('round-trips each kind', () => {
    expect(roundTrip(null)).toBeNull();
    expect(roundTrip({ kind: 'note', key: 'a-b' })).toEqual({ kind: 'note', key: 'a-b' });
    expect(roundTrip({ kind: 'new', seed: {} })).toEqual({ kind: 'new', seed: {} });
    const seed: NoteSeed = { value: { title: 'Hi, there', tags: ['x', 'y'], date: '2026-11-05' }, gestalt: 'appointment@1', relate: { from: 'k' }, preset: 'gestalt' };
    expect(roundTrip({ kind: 'new', seed })).toEqual({ kind: 'new', seed });
  });

  it('clears the seed of a previous new-note overlay', () => {
    expect(encodeOverlay({ kind: 'note', key: 'k' })).toMatchObject({ seed: null });
  });

  it('drops a seed that is not one', () => {
    expect(decodeOverlay(new URLSearchParams('overlay=new&seed={bad'))).toEqual({ kind: 'new', seed: {} });
    expect(decodeOverlay(new URLSearchParams('overlay=new&seed=' + encodeURIComponent('{"value":3,"preset":"x","gestalt":"g@1"}'))))
      .toEqual({ kind: 'new', seed: { gestalt: 'g@1' } });
  });

  it('ignores what it does not know', () => {
    expect(decodeOverlay(new URLSearchParams('overlay=bogus'))).toBeNull();
    expect(decodeOverlay(new URLSearchParams('overlay=note:'))).toBeNull();
  });
});
