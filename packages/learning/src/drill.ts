import { Rating, review, type Facet, type FsrsStates, type Grade, type ReviewState, type Scheduler } from './learning';

/**
 * Which item of a drill comes next: due ones mostly, otherwise new ones.
 */

export const DUE_PREFERENCE = 0.7;

/** An item is reviewed as a whole yml, without a facet. */
export const facetOf = (id: string): Facet => ({ target: id });

/** Unseen, or last rated Hard or Again. */
export function isStruggling(s: ReviewState | undefined): boolean {
  return !s || s.lastRating <= Rating.Hard;
}

/** The state after rating; when the item stops or starts struggling it is due again right away. */
export function rate(s: Scheduler, prev: ReviewState | undefined, grade: Grade, now: Date): ReviewState {
  const next = review(s, prev, grade, now);
  if (isStruggling(prev) !== isStruggling(next)) next.card.dueAt = now.toISOString();
  return next;
}

/**
 * Due items with probability DUE_PREFERENCE, else unseen ones (falling back to the other group). Never the previous
 * item; seen items that aren't due are skipped. `null`: nothing to practise now.
 */
export function nextItem<C extends { id: string }>(items: C[], states: FsrsStates, lastId: string | null, now: Date, random: () => number = Math.random): C | null {
  const candidates = items.filter((c) => c.id !== lastId);
  const due = candidates.filter((c) => { const s = states.get(facetOf(c.id)); return s && new Date(s.card.dueAt) <= now; });
  const unseen = candidates.filter((c) => !states.has(facetOf(c.id)));
  const [preferred, fallback] = random() < DUE_PREFERENCE ? [due, unseen] : [unseen, due];
  const pool = preferred.length ? preferred : fallback;
  return pool.length ? pool[Math.floor(random() * pool.length)] : null;
}
