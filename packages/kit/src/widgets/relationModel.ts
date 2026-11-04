import { INLINE, asMap, inlineRefs, relationships, tags, type IndexedNote, type Json, type RefsOf } from '@gestalts/sdk';

/**
 * Relationships of a note as rows, both directions: its own (`relationships`, and its inline `[[references]]`) and
 * the backlinks of other notes to it. Inline ones come from the text, so they're read-only here.
 */

/** A link from another note to this one. */
/** A link from another note to this one; `via`: how that note names this one (its id, or key). */
export type Backlink = { from: string; via: string; label: string | null; inline: boolean };

export type Row = {
  dir: 'out' | 'in';
  /** null: unlabelled */
  label: string | null;
  /** out: the target as written; in: the other note's key */
  other: string;
  /** in: how the other note names this one */
  via?: string;
  /** the other note's key, if it exists */
  otherKey: string | undefined;
  inline: boolean;
};

const RETIRED = 'retired';

/** Every note's incoming links by target key: explicit relationships, and inline references in the text. */
export function buildBacklinks(notes: IndexedNote[], keyOf: (id: string) => string | undefined, refsOf: RefsOf): Map<string, Backlink[]> {
  const out = new Map<string, Backlink[]>();
  const add = (to: string | undefined, b: Backlink, seen: Set<string>) => {
    if (!to || to === b.from) return;
    const id = `${to}\n${b.inline ? '\u0000inline' : (b.label ?? '')}`;
    if (seen.has(id)) return;
    seen.add(id);
    const list = out.get(to);
    if (list) list.push(b);
    else out.set(to, [b]);
  };
  for (const n of notes) {
    if (tags(n).includes(RETIRED)) continue;
    const seen = new Set<string>();
    for (const r of relationships(n)) {
      const inline = r.label === INLINE;
      add(keyOf(r.target), { from: n.key, via: r.target, label: inline ? null : r.label, inline }, seen);
    }
    for (const t of inlineRefs(n.value, refsOf).targets) add(keyOf(t), { from: n.key, via: t, label: null, inline: true }, seen);
  }
  return out;
}

/** The rows for `note`: its explicit relationships, its inline references, then its backlinks. */
export function rowsOf(note: IndexedNote, backlinks: Backlink[], keyOf: (id: string) => string | undefined, refsOf: RefsOf): Row[] {
  const rows: Row[] = [];
  const own = relationships(note);
  for (const r of own) {
    if (r.label === INLINE) continue;
    rows.push({ dir: 'out', label: r.label, other: r.target, otherKey: keyOf(r.target), inline: false });
  }
  const inline = new Set([...inlineRefs(note.value, refsOf).targets, ...own.filter((r) => r.label === INLINE).map((r) => r.target)]);
  inline.delete(note.id);
  for (const t of inline) rows.push({ dir: 'out', label: null, other: t, otherKey: keyOf(t), inline: true });
  for (const b of backlinks) rows.push({ dir: 'in', label: b.label, other: b.from, otherKey: b.from, via: b.via, inline: b.inline });
  return rows;
}

type JsonMap = { [key: string]: Json };

const rel = (target: string, label: string | null): Json => (label ? { to: target, label } : target);
const matches = (r: Json, target: string, label: string | null) => {
  if (typeof r === 'string') return r === target && !label;
  const m = asMap(r);
  return m?.to === target && ((m.label ?? null) === label || (!m.label && !label));
};
const relList = (v: JsonMap) => (Array.isArray(v.relationships) ? v.relationships : []);
const withRels = (v: JsonMap, rels: Json[]): JsonMap => {
  const next: JsonMap = { ...v, relationships: rels };
  if (!rels.length) delete next.relationships;
  return next;
};

/** `value` relating to `target` under `label` (empty: unlabelled), unless it already does. */
export function addRelation(value: JsonMap, target: string, label: string | null): JsonMap {
  const l = label?.trim() || null;
  const rels = relList(value);
  return rels.some((r) => matches(r, target, l)) ? value : withRels(value, [...rels, rel(target, l)]);
}

/** `value` without its first relationship to `target` under `label`. */
export function removeRelation(value: JsonMap, target: string, label: string | null): JsonMap {
  const rels = relList(value);
  const i = rels.findIndex((r) => matches(r, target, label));
  return i < 0 ? value : withRels(value, rels.filter((_, j) => j !== i));
}

/** `value` with its first relationship to `target` under `label` labelled `next` instead, in place. */
export function relabelRelation(value: JsonMap, target: string, label: string | null, next: string | null): JsonMap {
  const rels = relList(value);
  const i = rels.findIndex((r) => matches(r, target, label));
  if (i < 0) return value;
  const l = next?.trim() || null;
  if (rels.some((r, j) => j !== i && matches(r, target, l))) return removeRelation(value, target, label);
  return withRels(value, rels.map((r, j) => {
    if (j !== i) return r;
    const m = asMap(r);
    if (!m) return rel(target, l);
    const { label: _, ...rest } = m;
    return l ? { ...rest, label: l } : Object.keys(rest).length === 1 ? target : rest;
  }));
}
