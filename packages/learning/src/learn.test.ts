import { describe, expect, it } from 'vitest';
import type { Hashing, IndexedNote, Json } from '@gestalts/sdk';
import { learnableCards, pickNext, slotOf, until } from './learn';
import { fsrsStates } from './learning';

// stand-ins for the core's hashes (tested there)
const h: Hashing = { cardId: (front) => `card:${front.trim()}`, contentHash: (text) => `hash:${text}` };

function note(key: string, value: Json): IndexedNote {
  return { key, id: key, raw: JSON.stringify(value), value, parse_error: null, gestalts: [], lints: [] };
}
const flashcard = (key: string, front: string, host?: string) =>
  note(key, { tags: ['flashcard'], front, back: `back of ${front}`, ...(host ? { relationships: [{ to: host, label: 'card-of' }] } : {}) });

function state(key: string, target: string, facet: string | undefined, dueAt: string): IndexedNote {
  const value: Json = {
    tags: ['fsrs-state'], relationships: [{ to: target, label: 'reviews' }], model: 'FSRS-7', last_rating: 3,
    ...(facet ? { facet } : {}), card: { dueAt, reps: 1 },
  };
  return { ...note(key, value), gestalts: ['fsrs-state@1'] };
}

describe('learnableCards', () => {
  it('takes cards from hosts, attached flashcards and standalone flashcards', () => {
    const host = note('h', { title: 'H', cards: [{ id: 'c1', front: 'one', back: '1' }] });
    const cards = learnableCards([host], [flashcard('a', 'two', 'p'), flashcard('s', 'three')], h);
    expect(cards).toEqual([
      { facet: { target: 'h', facet: 'c1' }, front: 'one', back: '1', noteKey: 'h' },
      { facet: { target: 'p', facet: 'card:two' }, front: 'two', back: 'back of two', noteKey: 'a' },
      { facet: { target: 's' }, front: 'three', back: 'back of three', noteKey: 's' },
    ]);
  });

  it('leaves out attached cards of a host with the cards key, and counts a facet once', () => {
    const host = note('h', { cards: [{ id: 'x', front: 'f', back: 'b' }, { id: 'x', front: 'f', back: 'b2' }] });
    const cards = learnableCards([host], [flashcard('a', 'old', 'h'), flashcard('b', 'same', 'q'), flashcard('c', 'same', 'q')], h);
    expect(cards.map((c) => slotOf(c.facet))).toEqual([slotOf({ target: 'h', facet: 'x' }), slotOf({ target: 'q', facet: 'card:same' })]);
  });

  it('gives an attached card the slot it has once folded', () => {
    const attachedCard = learnableCards([], [flashcard('a', 'two', 'h')], h)[0];
    const foldedHost = note('h', { cards: [{ id: h.cardId('two'), front: 'two', back: 'b' }] });
    expect(learnableCards([foldedHost], [], h)[0].facet).toEqual(attachedCard.facet);
  });
});

describe('pickNext', () => {
  const now = new Date('2026-11-03T12:00:00Z');
  const cards = ['a', 'b', 'c'].map((t) => ({ facet: { target: t } }));

  it('picks due cards before new ones, and counts', () => {
    const states = fsrsStates([state('sa', 'a', undefined, '2026-11-03T11:00:00Z'), state('sb', 'b', undefined, '2026-11-04T12:00:00Z')]);
    const p = pickNext(cards, states, null, now, () => 0.99);
    expect(p.card?.facet.target).toBe('a');
    expect(p.counts).toEqual({ due: 1, new: 1, total: 3 });
    expect(p.nextDue).toBe('2026-11-04T12:00:00.000Z');
  });

  it('takes a new card when nothing is due, and nothing when neither', () => {
    const states = fsrsStates([state('sa', 'a', undefined, '2026-11-05T00:00:00Z'), state('sb', 'b', undefined, '2026-11-04T00:00:00Z')]);
    expect(pickNext(cards, states, null, now).card?.facet.target).toBe('c');
    const all = fsrsStates(['a', 'b', 'c'].map((t) => state(`s${t}`, t, undefined, '2026-11-05T00:00:00Z')));
    const p = pickNext(cards, all, null, now);
    expect(p.card).toBeNull();
    expect(p.nextDue).toBe('2026-11-05T00:00:00.000Z');
  });

  it('avoids the last card unless it is the only one', () => {
    const states = fsrsStates([state('sa', 'a', undefined, '2026-11-03T11:00:00Z')]);
    // a is due but was just shown: a new one comes first
    expect(pickNext(cards, states, slotOf({ target: 'a' }), now, () => 0).card?.facet.target).toBe('b');
    expect(pickNext([cards[0]], states, slotOf({ target: 'a' }), now).card?.facet.target).toBe('a');
  });

  it('keeps facets of one note apart', () => {
    const faceted = [{ facet: { target: 'n', facet: 'x' } }, { facet: { target: 'n', facet: 'y' } }];
    const states = fsrsStates([state('s', 'n', 'x', '2026-11-05T00:00:00Z')]);
    expect(pickNext(faceted, states, null, now).card?.facet.facet).toBe('y');
  });
});

describe('until', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  it('rounds down to the largest unit', () => {
    expect(until('2026-11-03T12:00:30Z', now)).toBe('<1m');
    expect(until('2026-11-03T15:30:00Z', now)).toBe('3h');
    expect(until('2026-11-07T12:00:00Z', now)).toBe('4d');
    expect(until('2028-05-03T12:00:00Z', now)).toBe('1.4y');
  });
});
