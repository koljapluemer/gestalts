/** A source updated from another version of it, as from BibTeX pasted again. */

import { FIELD_NAMES, type Bib, type FieldValue } from './fields';

export type MergeConflict = { field: string; current: FieldValue; incoming: FieldValue };
export type MergeResult = { value: Bib; filled: string[]; conflicts: MergeConflict[] };

const ORDER = ['title', 'key', 'entrytype', ...FIELD_NAMES] as const;
const same = (a: FieldValue | undefined, b: FieldValue | undefined) => JSON.stringify(a) === JSON.stringify(b);

/**
 * `current` with each field it lacks filled in from `incoming` (`filled`), and each it has otherwise replaced when in
 * `take`; those not in `take` are `conflicts`. `entrytype: misc` counts as none. A key taken from `incoming` may need
 * renaming when another source has it: that's for the caller to check.
 */
export function mergeSource(current: Bib, incoming: Bib, take: readonly string[] = []): MergeResult {
  const get = (b: Bib, name: string): FieldValue | undefined => {
    const v = (b as Record<string, FieldValue | undefined>)[name];
    return name === 'entrytype' && v === 'misc' ? undefined : v;
  };
  const value: Record<string, FieldValue> = { ...current };
  const filled: string[] = [];
  const conflicts: MergeConflict[] = [];
  for (const name of ORDER) {
    const now = get(current, name);
    const next = get(incoming, name);
    if (next === undefined || same(now, next)) continue;
    if (now === undefined) filled.push(name);
    else if (!take.includes(name)) { conflicts.push({ field: name, current: now, incoming: next }); continue; }
    value[name] = next;
  }
  return { value: value as Bib, filled, conflicts };
}
