import { Rating, review, type Facet, type FsrsStates, type Grade, type ReviewState, type Scheduler } from '@gestalts/learning';

/**
 * Which pronunciation card comes next, ported from sam-learns-things' ancient-greek-alphabet.
 * The FSRS state itself is the shared `fsrs-state@1` layer of `@gestalts/client`.
 */

export const DUE_PREFERENCE = 0.7;

/** A card is reviewed as a whole note, without a facet. */
export const facetOf = (id: string): Facet => ({ target: id });

/** Unseen, or last rated Hard or Again: show the image hint up front. */
export function isStruggling(s: ReviewState | undefined): boolean {
  return !s || s.lastRating <= Rating.Hard;
}

/** The state after rating; when the card stops or starts struggling it is due again right away. */
export function rate(s: Scheduler, prev: ReviewState | undefined, grade: Grade, now: Date): ReviewState {
  const next = review(s, prev, grade, now);
  if (isStruggling(prev) !== isStruggling(next)) next.card.dueAt = now.toISOString();
  return next;
}

/**
 * Due cards with probability DUE_PREFERENCE, else unseen ones (falling back to the other group).
 * Never the previous card; seen cards that aren't due are skipped. `null`: nothing to practise now.
 */
export function nextCard<C extends { id: string }>(
  cards: C[],
  states: FsrsStates,
  lastId: string | null,
  now: Date,
  random: () => number = Math.random,
): C | null {
  const candidates = cards.filter((c) => c.id !== lastId);
  const due = candidates.filter((c) => { const s = states.get(facetOf(c.id)); return s && new Date(s.card.dueAt) <= now; });
  const unseen = candidates.filter((c) => !states.has(facetOf(c.id)));
  const [preferred, fallback] = random() < DUE_PREFERENCE ? [due, unseen] : [unseen, due];
  const pool = preferred.length ? preferred : fallback;
  return pool.length ? pool[Math.floor(random() * pool.length)] : null;
}
