import { asMap, bib, str, type FieldKind, type IndexedNote, type Json, type Source } from '@gestalts/sdk';
import { foldText } from '@gestalts/kit';

/** A source note's fields as the bib functions take them. */
export const asSource = (n: IndexedNote): Source => (asMap(n.value) ?? {}) as Source;

/** A citekey from a title: its first significant word and the year, as people write them by hand. */
export function citekeyFor(title: string, date = ''): string {
  const words = foldText(title).replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean);
  const word = words.find((w) => w.length > 3) ?? words[0] ?? 'source';
  return `${word}${date.slice(0, 4)}` || 'source';
}

/** Citekeys used by more than one source. */
export function duplicateCitekeys(sources: IndexedNote[]): Set<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const s of sources) {
    const k = str(s, 'citekey');
    if (!k) continue;
    if (seen.has(k)) twice.add(k);
    seen.add(k);
  }
  return twice;
}

/** A field's value as it's edited: lists one item per line. */
export function fieldText(value: Json | undefined, kind: FieldKind | undefined): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('\n');
  if (kind === 'names' || kind === 'list') return String(value);
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** What an edited field's text stores: lists split by line, empty as nothing. */
export function fieldValue(text: string, kind: FieldKind | undefined): Json | undefined {
  if (kind === 'names' || kind === 'list') {
    const items = text.split('\n').map((l) => l.trim()).filter(Boolean);
    return items.length ? items : undefined;
  }
  const t = text.trim();
  return t ? t : undefined;
}

/** The source with `field` set (or removed, for undefined), other keys kept in their order. */
export function withField(value: Json | null, field: string, next: Json | undefined): Json {
  const v = { ...asMap(value) };
  if (next === undefined) delete v[field];
  else v[field] = next;
  return v;
}

export const model = () => bib.model();
