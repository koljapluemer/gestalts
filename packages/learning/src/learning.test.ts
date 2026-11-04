import { describe, expect, it } from 'vitest';
import { fsrsStates, fsrsStateValue, getScheduler, isAhead, Rating, review, stateFromNote, withLocal, type ReviewState } from './learning';
import type { IndexedNote, Json } from '@gestalts/sdk';

function stateNote(key: string, target: string, opts: { facet?: string; lastReviewAt?: string; reps?: number; dueAt?: string } = {}): IndexedNote {
  const value: Json = {
    tags: ['fsrs-state'], relationships: [{ to: target, label: 'reviews' }], model: 'FSRS-7', last_rating: 3,
    ...(opts.facet ? { facet: opts.facet } : {}),
    card: { dueAt: opts.dueAt ?? '2026-11-05T00:00:00.000Z', lastReviewAt: opts.lastReviewAt ?? null, reps: opts.reps ?? 1 },
  };
  return { key, id: key, raw: '', value, parse_error: null, gestalts: ['fsrs-state@1'], lints: [] };
}

describe('fsrsStates', () => {
  it('keeps the facets of a note apart from each other and from the whole note', () => {
    const states = fsrsStates([
      stateNote('w', 'q', { dueAt: '2026-11-01T00:00:00.000Z' }),
      stateNote('c1', 'q', { facet: 'cloze:1', dueAt: '2026-11-02T00:00:00.000Z' }),
      stateNote('c2', 'q', { facet: 'cloze:2', dueAt: '2026-11-03T00:00:00.000Z' }),
    ]);
    expect(states.get({ target: 'q' })?.key).toBe('w');
    expect(states.get({ target: 'q', facet: 'cloze:1' })?.key).toBe('c1');
    expect(states.get({ target: 'q', facet: 'cloze:2' })?.key).toBe('c2');
    expect(states.has({ target: 'q', facet: 'cloze:3' })).toBe(false);
    expect(states.has({ target: 'other' })).toBe(false);
  });

  it('picks the later review when two notes claim the same facet, in any order', () => {
    const old = stateNote('random-key', 'a', { lastReviewAt: '2026-10-01T00:00:00.000Z', reps: 5 });
    const recent = stateNote('stable-key', 'a', { lastReviewAt: '2026-10-02T00:00:00.000Z', reps: 1 });
    expect(fsrsStates([old, recent]).get({ target: 'a' })?.key).toBe('stable-key');
    expect(fsrsStates([recent, old]).get({ target: 'a' })?.key).toBe('stable-key');
    // same review time: more reps, then the key
    const a = stateNote('k1', 'b', { reps: 2 });
    const b = stateNote('k2', 'b', { reps: 1 });
    expect(fsrsStates([a, b]).get({ target: 'b' })?.key).toBe('k1');
    expect(fsrsStates([stateNote('k1', 'c'), stateNote('k2', 'c')]).get({ target: 'c' })?.key).toBe('k2');
  });

  it('with() returns a copy', () => {
    const states = fsrsStates([]);
    const next = states.with({ target: 'a', facet: 'x' }, { lastRating: Rating.Good, card: { dueAt: '2026-11-01T00:00:00.000Z' } });
    expect(states.has({ target: 'a', facet: 'x' })).toBe(false);
    expect(next.has({ target: 'a', facet: 'x' })).toBe(true);
    expect(next.has({ target: 'a' })).toBe(false);
  });

  it('skips notes that are not states', () => {
    expect(stateFromNote(stateNote('x', 'a'))?.facet).toBeUndefined();
    const broken: IndexedNote = { ...stateNote('y', 'a'), value: { tags: ['fsrs-state'] } };
    expect(stateFromNote(broken)).toBeNull();
  });
});

describe('review', () => {
  it('creates and advances a card, keeping the key and the dates as strings', async () => {
    const s = await getScheduler();
    const now = new Date('2026-11-01T12:00:00.000Z');
    const first = review(s, undefined, Rating.Good, now);
    expect(first.card.reps).toBe(1);
    expect(typeof first.card.dueAt).toBe('string');
    const later = new Date('2026-11-10T12:00:00.000Z');
    const second = review(s, { ...first, key: 'k' }, Rating.Good, later);
    expect(second.key).toBe('k');
    expect(second.card.reps).toBe(2);
    expect(second.card.lastReviewAt).toBe(later.toISOString());
    expect(new Date(second.card.dueAt).getTime()).toBeGreaterThan(later.getTime());
  });
});

describe('fsrsStateValue', () => {
  const s = { lastRating: Rating.Hard, card: { dueAt: '2026-11-01T00:00:00.000Z' } };
  it('writes the facet only when there is one', () => {
    expect(fsrsStateValue('k', { target: 'a' }, s)).toEqual({
      id: 'k', tags: ['fsrs-state'], relationships: [{ to: 'a', label: 'reviews' }], model: 'FSRS-7', last_rating: 2, card: s.card,
    });
    expect(fsrsStateValue('k', { target: 'a', facet: 'f' }, s)).toMatchObject({ facet: 'f' });
  });
});

describe('withLocal', () => {
  const at = (iso: string, reps = 1): ReviewState => ({ lastRating: Rating.Good, card: { dueAt: '2026-12-01T00:00:00Z', lastReviewAt: iso, reps } });
  const f = { target: 't', facet: 'c' };

  it('lays a local review over a missing or older stored one, not over the same or a newer one', () => {
    const empty = fsrsStates([]);
    const local = { facet: f, state: at('2026-11-03T12:00:00Z') };
    expect(withLocal(empty, [local]).get(f)).toBe(local.state);

    const older = empty.with(f, at('2026-11-02T12:00:00Z'));
    expect(isAhead(older, local)).toBe(true);
    expect(withLocal(older, [local]).get(f)).toBe(local.state);

    const caughtUp = empty.with(f, at('2026-11-03T12:00:00Z'));
    expect(isAhead(caughtUp, local)).toBe(false);
    expect(withLocal(caughtUp, [local]).get(f)).toBe(caughtUp.get(f));
  });
});
