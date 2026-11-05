import { defOf, type FieldProps, type FieldRule, type GestaltDef, type HostLens, type Json, type JsonMap, type Lint, type NoteGestalt } from '@gestalts/sdk';
import type { ComponentType } from 'react';

/** The note's text, shown and edited as its body (`Body`), whichever gestalts claim them. */
export const BODY_KEYS = ['title', 'tasks', 'main', 'extra'] as const;
/** Parts with editors of their own: cards and a template (folded into the note from attached notes). */
export const PART_KEYS = ['cards', 'template'] as const;
/** Fields other parts of the note show (tags, media and files, relationships) or that aren't the user's to edit here. */
const OWN_SECTION = ['id', 'tags', 'blobs', 'relationships', 'canvas'];
const RESERVED = new Set<string>([...BODY_KEYS, ...PART_KEYS, ...OWN_SECTION]);

/** One field as the properties show it. */
export type FieldSlot = {
  path: string;
  /** what the first gestalt claiming it asks of it; null when none does */
  rule: FieldRule | null;
  label: string;
  /** the lens's own field, else the default for its type */
  Field?: ComponentType<FieldProps>;
  /** `name@version` of each gestalt claiming it */
  claimedBy: string[];
  /** the note has it */
  set: boolean;
  /** a gestalt requires it (and it's missing, when `set` is false) */
  required: boolean;
  /** offered while editing even when unset (the lens's `offered`, else every field) */
  offered: boolean;
  /** the lints on it (or inside it) */
  lints: Lint[];
};

export type Section = {
  /** `name@version`; `other` for the fields no gestalt claims */
  id: string;
  title: string;
  /** the note has the gestalt; false: a candidate breaking some of its rules */
  has: boolean;
  /** asked for (a new appointment's gestalt), so shown first and open */
  focused: boolean;
  fields: FieldSlot[];
  /** the gestalt's lints on things not among `fields` (blobs, relationships, the whole note) */
  lints: Lint[];
};

const top = (path: string) => path.split('.')[0];
const nameOf = (id: string) => id.split('@')[0];
const pretty = (key: string) => key.replace(/[_-]+/g, ' ');

/**
 * How the properties show a note: one section per gestalt it has or is a candidate for (focused ones first, then by
 * lens priority, those it has before candidates, then by name), each with the fields it claims that no earlier one
 * did, and a last section with the fields no gestalt claims. The body, parts, tags, media and relationships are shown
 * elsewhere; their lints are under `bodyLints`.
 */
export function layoutOf({ value, lints, gestalts, defs, lenses, focus = [] }: {
  value: JsonMap;
  lints: Lint[];
  gestalts: NoteGestalt[];
  defs: GestaltDef[];
  lenses: HostLens[];
  focus?: string[];
}): { sections: Section[]; bodyLints: Lint[] } {
  const lensOf = (id: string) => lenses.find((l) => l.gestalt === id);
  const rank = (g: NoteGestalt) => [focus.includes(g.id) ? 0 : 1, -(lensOf(g.id)?.priority ?? 0), g.has ? 0 : 1] as const;
  const ordered = [...gestalts].sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return a.id.localeCompare(b.id);
  });
  const lintsAt = (path: string) => lints.filter((l) => top(l.path) === path);
  const claimers = (path: string) => ordered.filter((g) => defOf(defs, g.id)?.fields[path]).map((g) => g.id);
  const shown = new Set<string>();
  const sections: Section[] = [];

  for (const g of ordered) {
    const def = defOf(defs, g.id);
    const lens = lensOf(g.id);
    const declared = Object.keys(def?.fields ?? {});
    const offered = lens?.offered ? new Set(lens.offered(value)) : null;
    const fields = declared
      .filter((path) => !RESERVED.has(path) && !shown.has(path) && !lens?.fields?.[path]?.hidden)
      .map((path, i) => ({ path, i, order: lens?.fields?.[path]?.order }))
      .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.i - b.i)
      .map(({ path }): FieldSlot => {
        shown.add(path);
        const rule = def!.fields[path];
        return {
          path, rule, label: lens?.fields?.[path]?.label ?? pretty(path), Field: lens?.fields?.[path]?.Field,
          claimedBy: claimers(path), set: value[path] !== undefined, required: rule.required, offered: !offered || offered.has(path), lints: lintsAt(path),
        };
      });
    const own = new Set(declared);
    const rest = lints.filter((l) => l.gestalt === g.id && !own.has(top(l.path)) && !RESERVED.has(top(l.path)));
    // claimed fields shown elsewhere (body, tags) need no section of their own
    if (!fields.length && !rest.length) continue;
    sections.push({ id: g.id, title: lens?.title ?? nameOf(g.id), has: g.has, focused: focus.includes(g.id), fields, lints: rest });
  }

  const other = Object.keys(value).filter((k) => !RESERVED.has(k) && !shown.has(k));
  if (other.length) {
    sections.push({
      id: 'other', title: 'Other', has: true, focused: false, lints: [],
      fields: other.map((path) => ({ path, rule: null, label: pretty(path), claimedBy: [], set: true, required: false, offered: true, lints: lintsAt(path) })),
    });
  }
  const bodyLints = lints.filter((l) => RESERVED.has(top(l.path)) || l.path === '');
  return { sections, bodyLints };
}

/** The type a field without a rule is shown as, from its value. */
export function inferType(v: Json | undefined): FieldRule['type'] {
  if (typeof v === 'string') return v.includes('\n') ? 'text' : 'string';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (typeof v === 'boolean') return 'bool';
  if (Array.isArray(v)) return v.every((x) => typeof x === 'string') ? 'string_list' : 'list';
  if (v && typeof v === 'object') return 'map';
  return 'any';
}
