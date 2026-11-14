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
    expect(practiceEvent('concept', 'video', 0, now, { origin: 'v1' })).toMatchObject({ subject: 'concept', origin: 'v1', rating: 0 });
  });

  it('say what kind of answer it was, which item, and how long it took, when known', () => {
    expect(practiceEvent('q', 'math-drills', -1, now, { response: 'truncate', instance: { labels: { n: 3 } }, ms: 4100.6 }))
      .toMatchObject({ gestalt: 'practice-event@2', response: 'truncate', instance: { labels: { n: 3 } }, ms: 4101 });
    expect(practiceEvent('q', 'math-drills', 1, now, { ms: -3 })).toMatchObject({ ms: 0 });
    expect(practiceEvent('q', 'math-drills', 1, now, { origin: 'v' })).toMatchObject({ gestalt: 'practice-event@1' });
    expect(Object.keys(practiceEvent('q', 'math-drills', 1, now, {}))).not.toContain('response');
  });
});
