import type { Json, Query } from '@gestalts/sdk';

/** How many notes a draw shows. */
export const QUEUE_SIZE = 3;

/** The tag the hide toggle puts on a note to leave it out of the queue; toggling again takes it off. */
export const HIDE_TAG = 'no-q';

/**
 * The notes the queue draws from: your own notes. Edit what it leaves out here.
 * - as dsl's Queue: appointments, recurring items, sources, dailies, explorations
 * - bookkeeping: learner state, sessions, settings, installs, conflicts
 * - deck content (and copies of it): countries, words, sentences, cards, quotes…, practised in their own panes
 */
export const POOL: Query = {
  gestaltsNone: [
    'appointment@1', 'recurring@1', 'source@1', 'daily@1',
    'fsrs-state@1', 'practice-state@1', 'practice-session@1', 'settings@1', 'plugin-install@1', 'conflict@1',
    'country@1', 'term@1', 'sentence@1', 'scene-object@1', 'interaction@1', 'flashcard@1', 'pronunciation-card@1', 'quote@1',
  ],
  tagsNone: ['exploration', HIDE_TAG],
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

/** The note's value with `tag` added to its `tags` (or removed), the others kept in order. */
export function withTag(value: Json | null, tag: string, on: boolean): Json {
  const note = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const raw = note.tags;
  const tags = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
  const has = tags.includes(tag);
  if (on === has) return note;
  return { ...note, tags: on ? [...tags, tag] : tags.filter((t) => t !== tag) };
}
