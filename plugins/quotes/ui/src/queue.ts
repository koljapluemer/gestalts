import type { Facet, FsrsStates } from '@gestalts/learning';
import { levelCount } from './cloze';

export type Quote = { key: string; id: string; text: string; attribution?: string };

export type Candidate = { quote: Quote; level: number; facet: Facet; status: 'due' | 'new' };

/** Due cards come up 5 times in 6, new ones otherwise (when there are both). */
export const DUE_PREFERENCE = 5 / 6;

export const facetOf = (q: Quote, level: number): Facet => ({ target: q.id, facet: String(level) });

/**
 * A quote's frontier: its lowest level that's new or due. Levels above it wait until the ones below are learned,
 * so a quote is learned from its last word backwards.
 */
export function frontier(q: Quote, states: FsrsStates, now: Date): Candidate | null {
  for (let level = 1; level <= levelCount(q.text); level++) {
    const facet = facetOf(q, level);
    const s = states.get(facet);
    if (!s) return { quote: q, level, facet, status: 'new' };
    if (Date.parse(s.card.dueAt) <= now.getTime()) return { quote: q, level, facet, status: 'due' };
  }
  return null;
}

/**
 * The next cloze: a due one (mostly) or a new one, never from the quote just shown unless it's the only one with
 * anything to show, and preferring quotes not practised yet this session. `random` is in [0, 1).
 */
export function pickNext(quotes: Quote[], states: FsrsStates, now: Date, last: string | null, touched: ReadonlySet<string>, random: () => number = Math.random): Candidate | null {
  const all = quotes.flatMap((q) => frontier(q, states, now) ?? []);
  const others = all.filter((c) => c.quote.id !== last);
  const pickable = others.length ? others : all;
  const due = pickable.filter((c) => c.status === 'due');
  const fresh = pickable.filter((c) => c.status === 'new');
  const preferDue = random() < DUE_PREFERENCE;
  let pool = preferDue ? due : fresh;
  if (!pool.length) pool = preferDue ? fresh : due;
  if (!pool.length) return null;
  const untouched = pool.filter((c) => !touched.has(c.quote.id));
  const from = untouched.length ? untouched : pool;
  return from[Math.floor(random() * from.length)] ?? null;
}
