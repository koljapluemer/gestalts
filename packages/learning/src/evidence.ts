import type { JsonMap, useWrite } from '@gestalts/view';
import { Rating, type Grade } from './learning';

/**
 * Logging practice as it happened: `practice-event@1` ymls, one per answer (or per thing that came up). What an event
 * says about concepts isn't written down here; `estimate` works it out when it's read.
 */

/** A yml's `concepts` prop: concept id to how strongly it is practiced. */
export type ConceptStrengths = Record<string, number>;

/** -2 (went very badly) over 0 (came up, no score) to 2 (went very well). */
export type EventRating = -2 | -1 | 0 | 1 | 2;

const GRADE_RATING: Record<Grade, EventRating> = { [Rating.Again]: -2, [Rating.Hard]: -1, [Rating.Good]: 1, [Rating.Easy]: 2 };

export const ratingOf = (grade: Grade): EventRating => GRADE_RATING[grade];

/** The event for `subject` (a card, or a concept when there's no item), logged by `view`. */
export function practiceEvent(subject: string, view: string, rating: EventRating, now: Date, origin?: string): JsonMap {
  return { gestalt: 'practice-event@1', subject, ...(origin ? { origin } : {}), view, at: now.toISOString(), rating };
}

export async function logPractice(write: ReturnType<typeof useWrite>, subject: string, view: string, rating: EventRating, now: Date, origin?: string): Promise<void> {
  await write.put(practiceEvent(subject, view, rating, now, origin));
}
