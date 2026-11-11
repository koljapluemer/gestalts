/**
 * Finding existing sources that are probably the one about to be added.
 *
 * A shared identifier (DOI, ISBN, eprint) decides; without one, title, authors and year are compared loosely: a title
 * may be shortened or lose its subtitle, an author list end in `others`, a year be off by one (online first, preprint).
 * A field missing on either side counts neither way.
 */

import { bareDoi, isbn13 } from './fields';

export const LEVELS = ['same', 'likely', 'possible'] as const;
export type Level = (typeof LEVELS)[number];

/** What matching looks at: any source-shaped value. */
export type Comparable = { title?: unknown; author?: unknown; editor?: unknown; date?: unknown; doi?: unknown; isbn?: unknown; eprint?: unknown; eprinttype?: unknown; url?: unknown };

const STOPWORDS = new Set(
  ('a an and at by for from in into of on or the to with '
    + 'der die das ein eine und von zu im in mit fur auf uber '
    + 'le la les un une des du et en').split(' '),
);

/** Lowercase words without accents or punctuation, single-spaced. */
export function fold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

export const doiKey = (v: unknown) => bareDoi(v);
export const isbnKey = (v: unknown) => isbn13(v);

export function eprintKey(s: Comparable): string {
  let e = String(s.eprint ?? '').trim().toLowerCase();
  if (!e) return '';
  e = e.replace(/^arxiv:/, '').replace(/v\d+$/, '');
  return `${String(s.eprinttype || 'arxiv').trim().toLowerCase()}:${e}`;
}

export function urlKey(v: unknown): string {
  const s = String(v ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').split('#')[0];
  return s.replace(/^www\./, '').replace(/\/+$/, '');
}

/** `difflib.SequenceMatcher(None, a, b).ratio()`: twice the matched characters over both lengths. */
export function ratio(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const matched = (alo: number, ahi: number, blo: number, bhi: number): number => {
    // the longest common run, earliest in a, then in b
    let best = 0, bi = alo, bj = blo;
    let prev = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (let j = blo; j < bhi; j++) {
        if (a[i] !== b[j]) continue;
        const k = (prev.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > best) { best = k; bi = i - k + 1; bj = j - k + 1; }
      }
      prev = next;
    }
    if (!best) return 0;
    return best + matched(alo, bi, blo, bj) + matched(bi + best, ahi, bj + best, bhi);
  };
  return (2 * matched(0, a.length, 0, b.length)) / (a.length + b.length);
}

/** The title before its subtitle. */
const main = (title: string) => title.split(/:|\s[-–—]\s|\.\s/)[0];

export function titleSimilarity(a: string, b: string): number {
  const fa = fold(a), fb = fold(b);
  if (!fa || !fb) return 0;
  let best = Math.max(ratio(fa, fb), ratio(fold(main(a)), fold(main(b))));
  const words = (s: string) => new Set(s.split(' ').filter((w) => !STOPWORDS.has(w)));
  const [short, long] = [words(fa), words(fb)].sort((x, y) => x.size - y.size);
  if (short.size >= 2 && [...short].every((w) => long.has(w))) best = Math.max(best, 0.95);
  return best;
}

const names = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** The folded family names of the authors, else the editors, without `others`. */
export function families(s: Comparable): string[] {
  const list = names(s.author).length ? names(s.author) : names(s.editor);
  const out: string[] = [];
  for (const name of list) {
    let family: string;
    if (name.includes(',')) {
      const words = name.split(',')[0].trim().split(/\s+/);
      while (words.length > 1 && /^\p{Ll}/u.test(words[0])) words.shift(); // the prefix: `van`
      family = fold(words.join(' '));
    } else {
      // an organisation, or a name typed as spoken
      family = fold(name).split(' ').at(-1) ?? '';
    }
    if (family && family !== 'others') out.push(family);
  }
  return out;
}

export function year(s: Comparable): number | undefined {
  const m = /^\d{4}/.exec(String(s.date ?? ''));
  return m ? Number(m[0]) : undefined;
}

const IDS: [string, (s: Comparable) => string][] = [
  ['DOI', (s) => doiKey(s.doi)],
  ['ISBN', (s) => isbnKey(s.isbn)],
  ['eprint', eprintKey],
];

/** `[level, reasons, title score]` when `other` may be `entry`, else undefined. */
export function compare(entry: Comparable, other: Comparable): [Level, string[], number] | undefined {
  const reasons: string[] = [];
  let conflict = false;
  for (const [label, get] of IDS) {
    const a = get(entry), b = get(other);
    if (a && b) {
      if (a === b) return ['same', [label], 1];
      conflict = true;
      reasons.push(`≠${label}`);
    }
  }
  const ta = String(entry.title ?? ''), tb = String(other.title ?? '');
  const score = titleSimilarity(ta, tb);
  const fa = families(entry), fb = families(other);
  const first = !fa.length || !fb.length || fa[0] === fb[0];
  const overlap = fa.some((f) => fb.includes(f));
  const ya = year(entry), yb = year(other);
  const near = ya === undefined || yb === undefined || Math.abs(ya - yb) <= 1;
  const sameUrl = !!urlKey(entry.url) && urlKey(entry.url) === urlKey(other.url);

  if (score >= 0.75) reasons.push(`title ${Math.round(score * 100)}%`);
  if (fa.length && fb.length && (first || overlap)) reasons.push('author');
  if (ya && yb && ya !== yb) reasons.push(`${ya}≠${yb}`);
  if (sameUrl) reasons.unshift('URL');

  let level: Level;
  if (fold(ta) === fold(tb) && fa.length && fb.length && fa[0] === fb[0] && ya && ya === yb) level = 'same';
  else if (sameUrl || (score >= 0.9 && first && near)) level = 'likely';
  else if (score >= 0.75) level = 'possible';
  else return undefined;
  return [conflict ? 'possible' : level, reasons, score];
}

export type Candidate<T> = { source: T; level: Level; reasons: string[] };

/** The ones in `existing` that may be `entry`, best first. */
export function match<T extends Comparable>(entry: Comparable, existing: T[], limit = 3): Candidate<T>[] {
  const found: [Candidate<T>, number][] = [];
  for (const source of existing) {
    const hit = compare(entry, source);
    if (hit) found.push([{ source, level: hit[0], reasons: hit[1] }, hit[2]]);
  }
  found.sort((x, y) => LEVELS.indexOf(x[0].level) - LEVELS.indexOf(y[0].level) || y[1] - x[1]);
  return found.slice(0, limit).map((f) => f[0]);
}

/** Words of the title worth searching existing sources by (the longest few, without stopwords). */
export function titleWords(title: string, max = 4): string[] {
  const words = fold(main(title)).split(' ').filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, max);
}
