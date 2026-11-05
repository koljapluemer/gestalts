import { relationships, str, type IndexedNote, type Repo } from '@gestalts/sdk';
import type { Quote } from './queue';

export function quoteOf(n: IndexedNote): Quote | null {
  const text = str(n, 'main');
  if (!text?.trim()) return null;
  const attribution = str(n, 'attribution')?.trim();
  return { key: n.key, id: n.id, text, ...(attribution ? { attribution } : {}) };
}

/** A quote's learner state goes: its cloze levels start over (its words changed). */
export async function forgetPractice(repo: Repo, quoteId: string): Promise<void> {
  const states = repo.query({ gestalt: 'fsrs-state@1' }).filter((s) => relationships(s).some((r) => r.label === 'reviews' && r.target === quoteId));
  for (const s of states) await repo.delete(s.key);
}
