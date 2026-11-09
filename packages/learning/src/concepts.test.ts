import { describe, expect, it } from 'vitest';
import { conceptEvents } from './concepts';
import { Rating } from './learning';

const now = new Date('2026-11-01T12:00:00.000Z');

describe('conceptEvents', () => {
  it('maps grades onto event ratings', () => {
    const rating = (g: Parameters<typeof conceptEvents>[2]) => conceptEvents('o', { c: 1 }, g, now)[0].rating;
    expect([rating(Rating.Again), rating(Rating.Hard), rating(Rating.Good), rating(Rating.Easy)]).toEqual([-2, -1, 1, 2]);
  });

  it('writes one event per practiced concept and skips strength 0', () => {
    expect(conceptEvents('o', { a: 0.5, b: 0, c: 1 }, Rating.Good, now)).toEqual([
      { gestalt: 'concept-practice-event@1', concept: 'a', origin: 'o', at: now.toISOString(), rating: 1 },
      { gestalt: 'concept-practice-event@1', concept: 'c', origin: 'o', at: now.toISOString(), rating: 1 },
    ]);
  });

  it('has nothing to log without concepts', () => {
    expect(conceptEvents('o', undefined, Rating.Good, now)).toEqual([]);
  });
});
