import type { JsonMap, useWrite } from '@gestalts/view';
import { Rating, type Grade } from './learning';

/**
 * Logging what practice says about concepts: `concept-practice-event@1` ymls, for later models of what a learner knows.
 */

/** A yml's `concepts` prop: concept id to how strongly it is practiced. */
export type ConceptStrengths = Record<string, number>;

const EVENT_RATING: Record<Grade, number> = { [Rating.Again]: -2, [Rating.Hard]: -1, [Rating.Good]: 1, [Rating.Easy]: 2 };

/** One event per concept that `origin` practices at all. */
export function conceptEvents(origin: string, concepts: ConceptStrengths | undefined, grade: Grade, now: Date): JsonMap[] {
  const at = now.toISOString();
  return Object.entries(concepts ?? {})
    .filter(([, strength]) => strength > 0)
    .map(([concept]) => ({ gestalt: 'concept-practice-event@1', concept, origin, at, rating: EVENT_RATING[grade] }));
}

export async function logConceptPractice(write: ReturnType<typeof useWrite>, origin: string, concepts: ConceptStrengths | undefined, grade: Grade, now: Date): Promise<void> {
  await Promise.all(conceptEvents(origin, concepts, grade, now).map((e) => write.put(e)));
}
