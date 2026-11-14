import type { JsonMap, useWrite } from '@gestalts/view';
import { Rating, type Grade } from './learning';

/**
 * Logging practice as it happened: `practice-event` ymls, one per answer (or per thing that came up). What an event
 * says about concepts isn't written down here; the core works it out when it's read, from the subject's `concepts`
 * and `responses`.
 *
 * An event is written as the lowest version that holds what it says: `practice-event@1` unless it names a `response`,
 * `instance` or `ms`, which need `@2`. So a view declaring only `practice-event@1` keeps working as long as it says no
 * more, and one that says more declares `practice-event@2`.
 */

/** A yml's `concepts` prop: concept id to how strongly it is practiced. */
export type ConceptStrengths = Record<string, number>;

/** -2 (went very badly) over 0 (came up, no score) to 2 (went very well). */
export type EventRating = -2 | -1 | 0 | 1 | 2;

/** What else an event may say about how it happened. */
export type EventDetails = {
  /** where it came up, when that isn't the subject (a video) */
  origin?: string;
  /** what kind of answer it was: a key of the subject's (or its model's) `responses`, like a picked option's mistake */
  response?: string;
  /** which item exactly, in its model's terms (`version`, `seed`, `labels`) */
  instance?: JsonMap;
  /** how long the answer took */
  ms?: number;
};

const GRADE_RATING: Record<Grade, EventRating> = { [Rating.Again]: -2, [Rating.Hard]: -1, [Rating.Good]: 1, [Rating.Easy]: 2 };

export const ratingOf = (grade: Grade): EventRating => GRADE_RATING[grade];

/** The event for `subject` (an item, an item model, or a concept when there's no item), logged by `view`. */
export function practiceEvent(subject: string, view: string, rating: EventRating, now: Date, details: EventDetails = {}): JsonMap {
  const { origin, response, instance, ms } = details;
  const more = !!response || !!instance || ms !== undefined;
  return {
    gestalt: more ? 'practice-event@2' : 'practice-event@1',
    subject,
    ...(origin ? { origin } : {}),
    view,
    at: now.toISOString(),
    rating,
    ...(response ? { response } : {}),
    ...(instance ? { instance } : {}),
    ...(ms !== undefined ? { ms: Math.max(0, Math.round(ms)) } : {}),
  };
}

export async function logPractice(write: ReturnType<typeof useWrite>, subject: string, view: string, rating: EventRating, now: Date, details?: EventDetails): Promise<void> {
  await write.put(practiceEvent(subject, view, rating, now, details));
}
