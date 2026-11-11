import type { Belief } from '@gestalts/view';
import { facetOf } from './drill';
import type { FsrsStates } from './learning';

/**
 * Picking practice with the concept graph: items that share their main concept (the one they practise most) are
 * variants of one thing, like the ways to say "thank you" to different people, and what else each practises tells them
 * apart. Generic: nothing here knows about languages.
 */

export type Practising = { id: string; concepts: Record<string, number> };

/** The concept an item practises most (ties by id), if any. */
export function mainConcept(concepts: Record<string, number>): string | undefined {
  let best: [string, number] | undefined;
  for (const [id, w] of Object.entries(concepts)) if (w > 0 && (!best || w > best[1] || (w === best[1] && id < best[0]))) best = [id, w];
  return best?.[0];
}

/** Items by their main concept; an item practising nothing is a group of its own. */
export function variantGroups<C extends Practising>(items: C[]): Map<string, C[]> {
  const groups = new Map<string, C[]>();
  for (const i of items) {
    const key = mainConcept(i.concepts) ?? i.id;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  return groups;
}

/** A concept with no belief yet (still loading) counts as a coin flip, like one nothing reached. */
const pOf = (beliefs: Map<string, Belief>, id: string) => beliefs.get(id)?.p ?? 0.5;

/** How likely the rest of an item, beyond its main concept, goes right: the weighted mean of those concepts' `p`. */
export function sideStrength(item: Practising, beliefs: Map<string, Belief>): number | undefined {
  const main = mainConcept(item.concepts);
  const side = Object.entries(item.concepts).filter(([id, w]) => id !== main && w > 0);
  if (!side.length) return undefined;
  return side.reduce((a, [id, w]) => a + w * pOf(beliefs, id), 0) / side.reduce((a, [, w]) => a + w, 0);
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * A lesson: due items, at most one per group, the variant whose other concepts are weakest (so practice goes where the
 * gaps are), in random order, at most `max`.
 */
export function lessonPlan<C extends Practising>(items: C[], states: FsrsStates, beliefs: Map<string, Belief>, now: Date, { max = 10, random = Math.random }: { max?: number; random?: () => number } = {}): C[] {
  const due = items.filter((i) => { const s = states.get(facetOf(i.id)); return !!s && new Date(s.card.dueAt) <= now; });
  const picked = [...variantGroups(due).values()].map((group) => {
    const ranked = shuffle(group, random).map((i) => ({ i, weak: sideStrength(i, beliefs) ?? 1 }));
    return ranked.reduce((a, b) => (b.weak < a.weak ? b : a)).i;
  });
  return shuffle(picked, random).slice(0, max);
}

export type NewItem<C> = { item: C; headStart: number; strong: string[] };

/**
 * Unseen items, the cheapest to learn first: by the weighted mean `p` of everything they practise, which is high when
 * an item is mostly made of what's already known (another variant of a known phrase, a pronoun already in use).
 * `strong` names those concepts (p over `above`), strongest first.
 */
export function rankNew<C extends Practising>(items: C[], states: FsrsStates, beliefs: Map<string, Belief>, above = 0.6): NewItem<C>[] {
  return items
    .filter((i) => !states.has(facetOf(i.id)))
    .map((item) => {
      const entries = Object.entries(item.concepts).filter(([, w]) => w > 0);
      const total = entries.reduce((a, [, w]) => a + w, 0);
      const headStart = total ? entries.reduce((a, [id, w]) => a + w * pOf(beliefs, id), 0) / total : 0.5;
      const strong = entries.map(([id]) => [id, pOf(beliefs, id)] as const).filter(([, p]) => p > above).sort((a, b) => b[1] - a[1]).map(([id]) => id);
      return { item, headStart, strong };
    })
    .sort((a, b) => b.headStart - a.headStart || a.item.id.localeCompare(b.item.id));
}
