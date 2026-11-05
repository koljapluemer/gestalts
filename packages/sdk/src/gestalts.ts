import { asMap, type JsonMap } from './fields';
import type { GestaltDef, IndexedNote } from './types';

/** `name@version` */
export const gestaltId = (d: Pick<GestaltDef, 'name' | 'version'>) => `${d.name}@${d.version}`;

/** The definition of `id` (`name@version`) among `defs`. */
export const defOf = (defs: GestaltDef[], id: string) => defs.find((d) => gestaltId(d) === id);

/** A gestalt a note has (`has`), or is a candidate for while breaking some of its rules (its lints say which). */
export type NoteGestalt = { id: string; has: boolean };

/** The gestalts a note has, then those it's a candidate for but breaks, each once, in the core's order. */
export function noteGestalts(note: Pick<IndexedNote, 'gestalts' | 'lints'>): NoteGestalt[] {
  const out: NoteGestalt[] = note.gestalts.map((id) => ({ id, has: true }));
  const seen = new Set(note.gestalts);
  for (const l of note.lints) {
    if (!seen.has(l.gestalt)) { seen.add(l.gestalt); out.push({ id: l.gestalt, has: false }); }
  }
  return out;
}

/**
 * A new note's value meant to have `def`: `value` with the tags the gestalt requires added (the others kept in
 * order). Required fields stay unset; the note component shows them as missing, to fill in.
 */
export function seedFor(def: GestaltDef, value: JsonMap = {}): JsonMap {
  const raw = asMap(value)?.tags;
  const tags = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : [];
  const all = [...tags, ...def.requires_tags.filter((t) => !tags.includes(t))];
  return all.length ? { ...value, tags: all } : value;
}
