import { asMap } from './fields';
import type { IndexedNote, Json, Query } from './types';

/**
 * Conflicts a sync couldn't settle by any merge rule, as `conflict@1` notes (doc/gestalts.md#conflicts). The note
 * holds `kept`; `lost` is the other side's value at `path`.
 */
export type ConflictRecord = {
  key: string;
  /** the key of the note it's in */
  note: string;
  path: PathSegment[];
  base?: Json;
  kept?: Json;
  lost?: Json;
  /** `kept` and `lost` are whole note texts (one of them didn't parse) */
  raw: boolean;
  recorded: string;
};

/** A key, or the item of a list whose `by` field is `id`. */
export type PathSegment = string | { by: string; id: Json };

/** What resolving keeps: the value in the note, the other side's, or a value of one's own. */
export type Resolution = { take: 'kept' } | { take: 'lost' } | { value: Json | undefined };

type Writer = {
  query(q: Query): IndexedNote[];
  get(key: string): IndexedNote | undefined;
  putRaw(key: string, raw: string): Promise<unknown>;
  putValue(key: string | undefined, value: Json): Promise<unknown>;
  delete(key: string): Promise<unknown>;
};

export function conflictRecord(n: IndexedNote): ConflictRecord | null {
  const m = asMap(n.value);
  if (!m || typeof m.note !== 'string' || !Array.isArray(m.path)) return null;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(m, k);
  return {
    key: n.key,
    note: m.note,
    path: m.path.filter((s): s is PathSegment => typeof s === 'string' || !!asMap(s)) as PathSegment[],
    ...(has('base') ? { base: m.base } : {}),
    ...(has('kept') ? { kept: m.kept } : {}),
    ...(has('lost') ? { lost: m.lost } : {}),
    raw: m.raw === true,
    recorded: typeof m.recorded === 'string' ? m.recorded : '',
  };
}

/** Unresolved conflicts, oldest first; only those in the note `noteKey` if given. */
export function conflicts(repo: Pick<Writer, 'query'>, noteKey?: string): ConflictRecord[] {
  return repo
    .query({ gestalt: 'conflict@1', ...(noteKey ? { where: { note: noteKey } } : {}) })
    .flatMap((n) => conflictRecord(n) ?? [])
    .sort((a, b) => a.recorded.localeCompare(b.recorded) || a.key.localeCompare(b.key));
}

/** How a path reads to people: `cards[d15af94d944d].front`. */
export function pathLabel(path: PathSegment[]): string {
  return path.map((s, i) => (typeof s === 'string' ? (i ? `.${s}` : s) : `[${typeof s.id === 'string' ? s.id : JSON.stringify(s.id)}]`)).join('') || 'the whole note';
}

/**
 * Writes the chosen value at the conflict's path into its note, then deletes the conflict. Keeping `kept` writes
 * nothing to the note. Resolving the same conflict the same way on two devices writes identical notes, which merge
 * cleanly; that's what makes resolving in code safe, as long as the choice is deterministic.
 */
export async function resolveConflict(repo: Writer, c: ConflictRecord, how: Resolution): Promise<void> {
  if (!('take' in how && how.take === 'kept')) {
    const value = 'take' in how ? c.lost : how.value;
    if (c.raw || c.path.length === 0) {
      if (c.raw) await repo.putRaw(c.note, typeof value === 'string' ? value : '');
      else if (value === undefined) await repo.delete(c.note);
      else await repo.putValue(c.note, value);
    } else {
      const note = repo.get(c.note);
      const current = note?.value ?? {};
      await repo.putValue(c.note, setAt(current, c.path, value));
    }
  }
  await repo.delete(c.key);
}

/**
 * Resolves the conflicts of the notes matching `query` in code: `decide` returns a resolution, or null to leave one
 * to the user. `decide` must be deterministic (the same conflict, the same answer, on every device).
 */
export async function resolveConflicts(repo: Writer, query: Query, decide: (c: ConflictRecord, note: IndexedNote) => Resolution | null): Promise<number> {
  const keys = new Set(repo.query(query).map((n) => n.key));
  let n = 0;
  for (const c of conflicts(repo)) {
    const note = keys.has(c.note) ? repo.get(c.note) : undefined;
    if (!note) continue;
    const how = decide(c, note);
    if (how) {
      await resolveConflict(repo, c, how);
      n++;
    }
  }
  return n;
}

/** `root` with `value` at `path` (`undefined` removes it); missing maps and list items are created. */
export function setAt(root: Json, path: PathSegment[], value: Json | undefined): Json {
  if (path.length === 0) return value ?? null;
  const [head, ...rest] = path;
  if (typeof head === 'string') {
    const m = { ...asMap(root) };
    const next = setAt(m[head] ?? null, rest, value);
    if (rest.length === 0 && value === undefined) delete m[head];
    else m[head] = next;
    return m;
  }
  const list = Array.isArray(root) ? [...root] : [];
  const same = (a: Json | undefined, b: Json) => JSON.stringify(a) === JSON.stringify(b);
  const i = list.findIndex((item) => same(asMap(item)?.[head.by], head.id));
  if (rest.length === 0 && value === undefined) {
    if (i >= 0) list.splice(i, 1);
    return list;
  }
  const item = setAt(i >= 0 ? list[i] : { [head.by]: head.id }, rest, value);
  if (i >= 0) list[i] = item;
  else list.push(item);
  return list;
}
