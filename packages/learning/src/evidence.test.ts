import { describe, expect, it } from 'vitest';
import { practiceEvent, ratingOf } from './evidence';
import { Rating } from './learning';

const now = new Date('2026-11-01T12:00:00.000Z');

describe('practice events', () => {
  it('map grades onto ratings', () => {
    expect([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy].map(ratingOf)).toEqual([-2, -1, 1, 2]);
  });

  it('name their subject and view, and an origin only when there is one', () => {
    expect(practiceEvent('card', 'flashcards', 1, now)).toEqual({ gestalt: 'practice-event@1', subject: 'card', view: 'flashcards', at: now.toISOString(), rating: 1 });
    expect(practiceEvent('concept', 'video', 0, now, 'v1')).toMatchObject({ subject: 'concept', origin: 'v1', rating: 0 });
  });
});
