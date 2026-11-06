import type { Query } from '@gestalts/sdk';

/** A card crosses the stage in a random time between these, in seconds. */
export const MIN_S = 12;
export const MAX_S = 25;
/** How often a card sets off, in ms. */
export const SPAWN_MS = 2500;
/** How many notes a draw sends off before the next one. */
export const BATCH = 20;

/** The tag the hide toggle puts on a note to leave it out of Float; toggling again takes it off. */
export const HIDE_TAG = 'no-float';

/**
 * The notes Float draws from: your own notes. Edit what it leaves out here.
 * - as dsl's Float: appointments, recurring items, sources, dailies
 * - bookkeeping: learner state, sessions, settings, installs, conflicts
 * - deck content (and copies of it): countries, words, sentences, cards, quotes…, practised in their own panes
 */
export const POOL: Query = {
  gestaltsNone: [
    'appointment@1', 'recurring@1', 'source@1', 'daily@1',
    'fsrs-state@1', 'practice-state@1', 'practice-session@1', 'settings@1', 'plugin-install@1', 'conflict@1',
    'country@1', 'term@1', 'sentence@1', 'scene-object@1', 'interaction@1', 'flashcard@1', 'pronunciation-card@1', 'quote@1',
  ],
  tagsNone: [HIDE_TAG],
};

/** Up to `n` distinct keys, picked at random; `random` is in [0, 1). */
export function draw(keys: readonly string[], n: number, random: () => number = Math.random): string[] {
  const pool = [...keys];
  const count = Math.min(n, pool.length);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

/** Where a card sets off and how long it takes, from two random numbers in [0, 1). */
export function flight(a: number, b: number): { top: string; duration: number } {
  return { top: `${10 + a * 60}%`, duration: MIN_S + b * (MAX_S - MIN_S) };
}
