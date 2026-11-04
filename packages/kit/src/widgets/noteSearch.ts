import { aliases, noteLabel, str, tags, type IndexedNote } from '@gestalts/sdk';
import { words } from '../primitives';

/**
 * Search as you type, all client side.
 * A note matches when every query word is one of its words or a prefix of one.
 * Rarer words count more, exact words beat prefixes, and title/alias/main matches beat the rest.
 * Filters: `tag:x` / `#x`, `gestalt:name@1`, `-word` excludes.
 */

type Doc = {
  note: IndexedNote;
  all: Set<string>;
  title: Set<string>;
  aliases: Set<string>;
  main: Set<string>;
  label: string;
  tags: string[];
};

export type SearchIndex = Doc[];

export function buildIndex(notes: IndexedNote[]): SearchIndex {
  return notes.map((note) => ({
    note,
    all: new Set([...words(note.raw), ...words(note.key)]),
    title: new Set(words(str(note, 'title') ?? '')),
    aliases: new Set(aliases(note).flatMap(words)),
    main: new Set(words(str(note, 'main') ?? '')),
    label: noteLabel(note),
    tags: tags(note),
  }));
}

export type ParsedQuery = { terms: string[]; exclude: string[]; tags: string[]; gestalts: string[] };

export function parseQuery(q: string): ParsedQuery {
  const out: ParsedQuery = { terms: [], exclude: [], tags: [], gestalts: [] };
  for (const token of q.trim().split(/\s+/).filter(Boolean)) {
    if (token.startsWith('#') && token.length > 1) out.tags.push(token.slice(1));
    else if (token.startsWith('tag:') && token.length > 4) out.tags.push(token.slice(4));
    else if (token.startsWith('gestalt:') && token.length > 8) out.gestalts.push(token.slice(8));
    else if (token.startsWith('-') && token.length > 1) out.exclude.push(...words(token.slice(1)));
    else out.terms.push(...words(token));
  }
  return out;
}

/** 0: no match, 1: prefix of a word, 2: a word */
function matchIn(set: Set<string>, term: string): 0 | 1 | 2 {
  if (set.has(term)) return 2;
  for (const w of set) if (w.startsWith(term)) return 1;
  return 0;
}

export function search(index: SearchIndex, query: string, extraTags: string[] = []): { notes: IndexedNote[]; terms: string[] } {
  const q = parseQuery(query);
  const wantTags = [...q.tags, ...extraTags];
  const candidates = index.filter(
    (d) =>
      wantTags.every((t) => d.tags.includes(t)) &&
      q.gestalts.every((g) => d.note.gestalts.includes(g)) &&
      q.exclude.every((x) => matchIn(d.all, x) === 0),
  );
  if (!q.terms.length) {
    const sorted = [...candidates].sort((a, b) => a.label.localeCompare(b.label));
    return { notes: sorted.map((d) => d.note), terms: [] };
  }
  const df = new Map(q.terms.map((t) => [t, index.filter((d) => matchIn(d.all, t) > 0).length]));
  const n = index.length;
  const scored: { d: Doc; score: number }[] = [];
  for (const d of candidates) {
    let score = 0;
    let ok = true;
    for (const t of q.terms) {
      const m = matchIn(d.all, t);
      if (!m) { ok = false; break; }
      const idf = Math.log(1 + n / Math.max(df.get(t) ?? 1, 1));
      const field = matchIn(d.title, t) ? 2 : matchIn(d.aliases, t) ? 1.8 : matchIn(d.main, t) ? 1.3 : 1;
      score += idf * (m === 2 ? 1 : 0.6) * field;
    }
    if (!ok) continue;
    const phrase = q.terms.join(' ');
    if (q.terms.length > 1 && words(d.label).join(' ').includes(phrase)) score *= 1.5;
    scored.push({ d, score });
  }
  scored.sort((a, b) => b.score - a.score || a.d.label.localeCompare(b.d.label));
  return { notes: scored.map((s) => s.d.note), terms: q.terms };
}
