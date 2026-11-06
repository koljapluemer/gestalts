import { noteLine } from './gist';
import type { IndexedNote, Json, Ref } from './types';

/** Helpers for the conventional fields; all tolerate any YAML. */

export type JsonMap = { [key: string]: Json };

export function asMap(v: Json | null | undefined): JsonMap | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

export function field(n: IndexedNote, name: string): Json | undefined {
  return asMap(n.value)?.[name];
}

export function str(n: IndexedNote, name: string): string | undefined {
  const v = field(n, name);
  return typeof v === 'string' ? v : undefined;
}

/** A list of strings (a lone string counts as one). */
export function strList(n: IndexedNote, name: string): string[] {
  const v = field(n, name);
  if (typeof v === 'string') return [v];
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
}

export const tags = (n: IndexedNote) => strList(n, 'tags');
export const aliases = (n: IndexedNote) => strList(n, 'aliases');

function refs(n: IndexedNote, name: string, targetKey: string): Ref[] {
  const v = field(n, name);
  if (!Array.isArray(v)) return [];
  return v.flatMap((item): Ref[] => {
    if (typeof item === 'string') return [{ target: item, label: null }];
    const m = asMap(item);
    const target = m?.[targetKey];
    if (typeof target !== 'string') return [];
    return [{ target, label: typeof m?.label === 'string' ? m.label : null }];
  });
}

export const relationships = (n: IndexedNote) => refs(n, 'relationships', 'to');
export const blobs = (n: IndexedNote) => refs(n, 'blobs', 'file');

/** The blob file with this label, if any. */
export function blob(n: IndexedNote, label: string): string | undefined {
  return blobs(n).find((b) => b.label === label)?.target;
}

/** What to call a note in one line (`noteLine`, without lenses' parts); never empty, never its YAML. */
export function noteLabel(n: IndexedNote): string {
  return noteLine(asMap(n.value) ?? {}) || untitled(n);
}

/** A note with nothing to name it by: `Untitled`, and what it is (`Untitled canvas`). */
export const untitled = (n: IndexedNote) => (n.gestalts[0] ? `Untitled ${n.gestalts[0].split('@')[0]}` : 'Untitled note');

/** The note's value with `tag` added to its `tags` (or removed), the others kept in order; unchanged: the same value. */
export function withTag(value: Json | null, tag: string, on: boolean): Json {
  const note = asMap(value) ?? {};
  const raw = note.tags;
  const tags = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
  const has = tags.includes(tag);
  if (on === has) return note;
  return { ...note, tags: on ? [...tags, tag] : tags.filter((t) => t !== tag) };
}
