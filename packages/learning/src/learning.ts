import { DefaultScheduler, Rating, type Grade } from 'ts-fsrs';
import { asMap, field, relationships, type IndexedNote, type Json } from '@gestalts/sdk';

/**
 * FSRS learner state, per reviewed note or one facet of it, stored as `fsrs-state@1` notes.
 * Pure: the repo side (keys, writes, the session log) is in `practice.tsx`.
 */

export const MODEL = 'FSRS-7' as const;

const makeScheduler = () => DefaultScheduler({ version: MODEL });
export type Scheduler = Awaited<ReturnType<typeof makeScheduler>>;
type SchedulerCard = Parameters<Scheduler['review']>[0]['card'];

let scheduler: Promise<Scheduler> | null = null;
export function getScheduler(): Promise<Scheduler> {
  scheduler ??= makeScheduler();
  return scheduler;
}

/** What is reviewed: the note `target` (its id, as in `reviews`), or one `facet` of it (a card id, a cloze level). */
export type Facet = { target: string; facet?: string };

/** A learner's state as stored: the ts-fsrs card with dates as ISO strings. */
export type ReviewState = {
  /** key of the fsrs-state note, if saved */
  key?: string;
  lastRating: Grade;
  card: { [k: string]: Json } & { dueAt: string; lastReviewAt?: Json; reps?: Json };
};

export function stateFromNote(n: IndexedNote): (Facet & { state: ReviewState }) | null {
  const target = relationships(n).find((r) => r.label === 'reviews')?.target;
  const card = asMap(field(n, 'card'));
  const lastRating = field(n, 'last_rating');
  if (!target || !card || typeof card.dueAt !== 'string' || typeof lastRating !== 'number') return null;
  const facet = field(n, 'facet');
  return {
    target,
    ...(typeof facet === 'string' && facet ? { facet } : {}),
    state: { key: n.key, lastRating: lastRating as Grade, card: card as ReviewState['card'] },
  };
}

const slot = (f: Facet) => `${f.target}\u0000${f.facet ?? ''}`;

const reviewedAt = (s: ReviewState) => (typeof s.card.lastReviewAt === 'string' ? Date.parse(s.card.lastReviewAt) || 0 : 0);
const reps = (s: ReviewState) => (typeof s.card.reps === 'number' ? s.card.reps : 0);

/** The later review wins; then more reps, then the key, so every device picks the same note. */
function newer(a: ReviewState, b: ReviewState): boolean {
  if (reviewedAt(a) !== reviewedAt(b)) return reviewedAt(a) > reviewedAt(b);
  if (reps(a) !== reps(b)) return reps(a) > reps(b);
  return (a.key ?? '') > (b.key ?? '');
}

export type FsrsStates = {
  get(f: Facet): ReviewState | undefined;
  has(f: Facet): boolean;
  /** a copy with `f` set to `s` */
  with(f: Facet, s: ReviewState): FsrsStates;
};

function makeStates(m: Map<string, ReviewState>): FsrsStates {
  return {
    get: (f) => m.get(slot(f)),
    has: (f) => m.has(slot(f)),
    with: (f, s) => makeStates(new Map(m).set(slot(f), s)),
  };
}

/**
 * The states of `fsrs-state@1` notes by what they review. Facets of one note are kept apart, and a state without a
 * facet is the whole note's. Two notes for the same facet (a legacy random key next to the stable one): see `newer`.
 */
export function fsrsStates(notes: IndexedNote[]): FsrsStates {
  const m = new Map<string, ReviewState>();
  for (const n of notes) {
    const s = stateFromNote(n);
    if (!s) continue;
    const prev = m.get(slot(s));
    if (!prev || newer(s.state, prev)) m.set(slot(s), s.state);
  }
  return makeStates(m);
}

/** A review made here and not yet (known to be) saved. */
export type LocalReview = { facet: Facet; state: ReviewState };

/** Whether `stored` still lacks `r`: it has no state for the facet, or an older one. */
export function isAhead(stored: FsrsStates, r: LocalReview): boolean {
  const s = stored.get(r.facet);
  return !s || newer(r.state, s);
}

/** `stored` with the `local` reviews laid over it, where they're ahead of it. */
export function withLocal(stored: FsrsStates, local: LocalReview[]): FsrsStates {
  return local.reduce((states, r) => (isAhead(stored, r) ? states.with(r.facet, r.state) : states), stored);
}

function toSchedulerCard(stored: ReviewState['card']): SchedulerCard {
  const lastReviewAt = stored.lastReviewAt;
  return { ...stored, dueAt: new Date(stored.dueAt), lastReviewAt: typeof lastReviewAt === 'string' ? new Date(lastReviewAt) : null } as unknown as SchedulerCard;
}

function toStoredCard(card: SchedulerCard): ReviewState['card'] {
  return JSON.parse(JSON.stringify(card)) as ReviewState['card'];
}

/** The state after rating `grade` at `now`; a new card if there's no `prev`. Keeps `prev`'s key. */
export function review(s: Scheduler, prev: ReviewState | undefined, grade: Grade, now: Date): ReviewState {
  const card = prev ? toSchedulerCard(prev.card) : (s.newCard({ now }) as SchedulerCard);
  const reviewed = s.review({ card, grade, now }).card as SchedulerCard;
  return { key: prev?.key, lastRating: grade, card: toStoredCard(reviewed) };
}

/** The `fsrs-state@1` note for `f` in state `s`, under `key` (also its `id`). */
export function fsrsStateValue(key: string, f: Facet, s: ReviewState): Json {
  return {
    id: key,
    tags: ['fsrs-state'],
    relationships: [{ to: f.target, label: 'reviews' }],
    model: MODEL,
    ...(f.facet ? { facet: f.facet } : {}),
    last_rating: s.lastRating,
    card: s.card,
  };
}

export { Rating };
export type { Grade };
