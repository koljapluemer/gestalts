import { describe, expect, it } from 'vitest';
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
    expect(roundTrip({ kind: 'new' })).toEqual({ kind: 'new' });
    expect(roundTrip({ kind: 'new', title: 'Hi, there', tags: ['x', 'y'] })).toEqual({ kind: 'new', title: 'Hi, there', tags: ['x', 'y'] });
  });

  it('clears the prefill of a previous new-note overlay', () => {
    expect(encodeOverlay({ kind: 'note', key: 'k' })).toMatchObject({ 'new-title': null, 'new-tags': null });
  });

  it('ignores what it does not know', () => {
    expect(decodeOverlay(new URLSearchParams('overlay=bogus'))).toBeNull();
    expect(decodeOverlay(new URLSearchParams('overlay=note:'))).toBeNull();
  });
});
