import type { Card } from '@gestalts/sdk';

type Merge3 = (base: string | null, local: string | null, remote: string | null) => { text: string | null; conflicts: unknown[] };

/** What saving a draft does: write `text`, or stop because the note changed meanwhile in the same place. */
export type DraftSave = { kind: 'write'; text: string } | { kind: 'conflict' };

/**
 * Saving a draft of a note that may have changed since the draft started (`base`), e.g. a canvas save or a sync
 * landed meanwhile: unchanged, the draft as it is; else the draft merged in, as a sync merges.
 * When both changed the same key differently (or the note went away), nothing is written over the other change.
 */
export function draftSave(base: string, draft: string, current: string | null, merge3: Merge3): DraftSave {
  if (current === base) return { kind: 'write', text: draft };
  if (current === null) return { kind: 'conflict' };
  const m = merge3(base, draft, current);
  return m.conflicts.length || m.text === null ? { kind: 'conflict' } : { kind: 'write', text: m.text };
}

/** Cards as saved: empty ones dropped, new ones (no id yet) named by their front, ids unique. */
export function finalCards(cards: Card[], idOf: (front: string) => string): Card[] {
  const taken = new Set(cards.filter((c) => c.id).map((c) => c.id));
  return cards.filter((c) => c.front.trim() || c.back.trim()).map((c) => {
    if (c.id) return c;
    let id = idOf(c.front);
    for (let i = 2; taken.has(id); i++) id = `${idOf(c.front)}-${i}`;
    taken.add(id);
    return { ...c, id };
  });
}
