import { asMap, relationships, str, type IndexedNote, type Json, type Repo } from '@gestalts/sdk';
import type { Quote } from './queue';

export function quoteOf(n: IndexedNote): Quote | null {
  const text = str(n, 'main');
  if (!text?.trim()) return null;
  const attribution = str(n, 'attribution')?.trim();
  return { key: n.key, id: n.id, text, ...(attribution ? { attribution } : {}) };
}

/** Saves a quote (a new one without `key`); a changed text starts its cloze levels over. */
export async function saveQuote(repo: Repo, key: string | undefined, text: string, attribution: string): Promise<void> {
  const old = key ? repo.get(key) : undefined;
  const value: Record<string, Json> = { ...asMap(old?.value), tags: ['quote'], main: text.trim() };
  if (attribution.trim()) value.attribution = attribution.trim();
  else delete value.attribution;
  await repo.putValue(key, value);
  if (old && str(old, 'main')?.trim() !== text.trim()) {
    const states = repo.query({ gestalt: 'fsrs-state@1' }).filter((s) => relationships(s).some((r) => r.label === 'reviews' && r.target === old.id));
    for (const s of states) await repo.delete(s.key);
  }
}
