import { describe, expect, it } from 'vitest';
import { type IndexedNote, type Json } from '@gestalts/sdk';
import { fsrsStates, getScheduler, Rating } from '@gestalts/learning';
import { isStruggling, nextCard, rate } from './schedule';

const now = new Date('2026-11-01T12:00:00.000Z');
const cards = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('rate', () => {
  it('is due again right away when it stops struggling', async () => {
    const s = await getScheduler();
    const first = rate(s, undefined, Rating.Good, now);
    expect(first.card.dueAt).toBe(now.toISOString());
    const later = new Date('2026-11-02T12:00:00.000Z');
    expect(new Date(rate(s, first, Rating.Good, later).card.dueAt).getTime()).toBeGreaterThan(later.getTime());
  });

  it('marks Hard and Again as struggling', async () => {
    const s = await getScheduler();
    const hard = rate(s, undefined, Rating.Hard, now);
    expect(isStruggling(hard)).toBe(true);
    expect(isStruggling(undefined)).toBe(true);
    expect(isStruggling(rate(s, hard, Rating.Easy, now))).toBe(false);
  });
});

describe('nextCard', () => {
  const stateNote = (target: string, dueAt: string): IndexedNote => {
    const value: Json = { tags: ['fsrs-state'], relationships: [{ to: target, label: 'reviews' }], last_rating: 3, card: { dueAt } };
    return { key: target, id: target, raw: '', value, parse_error: null, gestalts: ['fsrs-state@1'], lints: [] };
  };

  it('prefers due cards, else unseen, never the last one', () => {
    const states = fsrsStates([stateNote('a', '2026-11-01T00:00:00Z'), stateNote('b', '2026-12-01T00:00:00Z')]);
    // random < 0.7: due first
    expect(nextCard(cards, states, null, now, () => 0)?.id).toBe('a');
    // random >= 0.7: unseen first
    expect(nextCard(cards, states, null, now, () => 0.9)?.id).toBe('c');
    // the due one was just shown: fall back to unseen
    expect(nextCard(cards, states, 'a', now, () => 0)?.id).toBe('c');
  });

  it('returns null when nothing is due or unseen', () => {
    const states = fsrsStates(cards.map((c) => stateNote(c.id, '2027-01-01T00:00:00Z')));
    expect(nextCard(cards, states, null, now)).toBeNull();
  });
});
