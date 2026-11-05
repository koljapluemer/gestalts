import type { Json, JsonMap } from '@gestalts/sdk';

/** Equal as stored: a missing field and an unset (`undefined`) one are the same. */
export const same = (a: Json | undefined, b: Json | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null) && (a === undefined) === (b === undefined);

/** A field's value as written: a title on one line; empty text, an empty list and an empty map take the field off. */
export function normalize(key: string, v: Json | undefined): Json | undefined {
  if (v === undefined || v === null) return v === null ? null : undefined;
  if (typeof v === 'string') {
    const s = key === 'title' ? v.replace(/\s*\n\s*/g, ' ').trim() : v;
    return s.trim() ? s : undefined;
  }
  if (Array.isArray(v)) return v.length ? v : undefined;
  if (typeof v === 'object') return Object.keys(v).length ? v : undefined;
  return v;
}

export type DraftPlan = { kind: 'write'; value: JsonMap; changed: string[] } | { kind: 'conflict'; keys: string[] };

/**
 * A draft of a note's value saved onto the note as it is now (`current`), field by field: each top-level field the
 * draft changed (against `base`, the note when the draft started) is set, or taken off when emptied; the note's other
 * fields stay as they are now. When the note meanwhile changed one of those fields to something else, nothing is
 * written over it, unless `force`.
 */
export function applyValueDraft(current: JsonMap, base: JsonMap, draft: JsonMap, force = false): DraftPlan {
  const next: JsonMap = { ...current };
  const changed: string[] = [];
  const conflicts: string[] = [];
  for (const k of new Set([...Object.keys(base), ...Object.keys(draft)])) {
    const d = normalize(k, draft[k]);
    if (same(d, base[k]) || same(d, current[k])) continue;
    if (!force && !same(current[k], base[k])) { conflicts.push(k); continue; }
    changed.push(k);
    if (d === undefined) delete next[k];
    else next[k] = d;
  }
  return conflicts.length ? { kind: 'conflict', keys: conflicts } : { kind: 'write', value: next, changed };
}

/** `value` with `patch` applied: a field patched to `undefined` is taken off. */
export function patched(value: JsonMap, patch: Record<string, Json | undefined>): JsonMap {
  const next: JsonMap = { ...value };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  return next;
}
