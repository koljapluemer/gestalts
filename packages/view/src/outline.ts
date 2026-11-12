import type { Item, OutlineEntry, OutlineMark, OutlinePage, OutlineQuery, OutlineStatus } from './types';

/**
 * The same outline the core works out (`crates/core/src/outline.rs`, which says what it means), over a fixture's ymls,
 * done plainly: everything again on each ask.
 */
export function outlinePage(all: Item[], q: OutlineQuery): OutlinePage {
  const { spec } = q;
  const notes = new Map(all.filter((i) => i.gestalt === spec.gestalt).map((i) => [i.id, i]));
  const ids = [...notes.keys()].sort();
  const tags = (i: Item) => (Array.isArray(i.value.tags) ? i.value.tags : []);
  const places = (i: Item): ['f' | 'b', string][] => {
    const rel = i.value[spec.field];
    if (!Array.isArray(rel)) return [];
    return rel.flatMap((r): ['f' | 'b', string][] => {
      if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.to !== 'string') return [];
      if (r.label === spec.follows) return [['f', r.to]];
      if (r.label === spec.branches) return [['b', r.to]];
      return [];
    });
  };
  const marks = new Map<string, OutlineMark[]>();
  const mark = (id: string, kind: OutlineMark['kind'], target?: string) => marks.set(id, [...(marks.get(id) ?? []), target === undefined ? { kind } : { kind, target }]);
  const root = ids.find((id) => tags(notes.get(id)!).includes(spec.rootTag));
  const place = new Map<string, ['f' | 'b', string]>();
  for (const id of ids) {
    const n = notes.get(id)!;
    const ps = places(n);
    if (tags(n).includes(spec.rootTag) && id !== root) mark(id, 'extraRoot');
    if (!ps.length) continue;
    if (id === root) { mark(id, 'rootPlaced'); continue; }
    if (ps.length > 1) mark(id, 'placedTwice');
    if (tags(n).includes(spec.excludeTag)) mark(id, 'excludedPlaced');
    place.set(id, ps[0]);
  }
  const after = new Map<string, string[]>();
  const under = new Map<string, string[]>();
  for (const id of ids) {
    const p = place.get(id);
    if (!p) continue;
    const list = p[0] === 'f' ? after : under;
    list.set(p[1], [...(list.get(p[1]) ?? []), id]);
  }
  for (const [target, list] of [...after, ...under]) list.slice(1).forEach((id) => mark(id, 'fork', target));
  const status = new Map<string, OutlineStatus>();
  for (const id of ids) {
    if (place.has(id)) continue;
    const n = notes.get(id)!;
    status.set(id, id === root ? 'root' : tags(n).includes(spec.rootTag) ? 'floating' : tags(n).includes(spec.excludeTag) ? 'excluded' : 'unplaced');
  }
  for (const id of ids) {
    if (status.has(id)) continue;
    const path: string[] = [];
    let cur = id;
    let attached: boolean;
    for (;;) {
      const s = status.get(cur);
      if (s) { attached = s === 'root' || s === 'attached'; break; }
      const at = path.indexOf(cur);
      if (at >= 0) {
        const lowest = path.slice(at).sort()[0];
        mark(lowest, 'cycle', place.get(lowest)![1]);
        attached = false;
        break;
      }
      const p = place.get(cur);
      if (!p) { attached = false; break; }
      path.push(cur);
      cur = p[1];
    }
    path.forEach((p) => status.set(p, attached ? 'attached' : 'floating'));
  }
  for (const [id, [, target]] of place) {
    if (status.get(id) !== 'floating') continue;
    const t = status.get(target);
    if (t === undefined) mark(id, 'parentMissing', target);
    else if (t === 'unplaced') mark(id, 'parentUnplaced', target);
    else if (t === 'excluded') mark(id, 'parentExcluded', target);
  }
  const sequence = (heads: string[]) => {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [...heads].reverse();
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      stack.push(...[...(after.get(id) ?? [])].reverse());
    }
    return out;
  };
  const pathOf = (id: string) => {
    const out: string[] = [];
    const seen = new Set<string>();
    let cur = id;
    while (!seen.has(cur)) {
      seen.add(cur);
      const p = place.get(cur);
      if (!p || (p[0] === 'b' && !notes.has(p[1]))) break;
      if (p[0] === 'b') out.push(p[1]);
      cur = p[1];
    }
    return out.reverse();
  };
  const below = (id: string, subject: string) => {
    const seen = new Set<string>();
    for (let cur: string | undefined = id; cur !== undefined && !seen.has(cur); cur = place.get(cur)?.[1]) {
      if (cur === subject) return true;
      seen.add(cur);
    }
    return false;
  };
  const project = (i: Item): Item => {
    if (!q.fields) return i;
    const keep = new Set(['id', 'gestalt', ...q.fields]);
    return { ...i, value: Object.fromEntries(Object.entries(i.value).filter(([k]) => keep.has(k))) };
  };
  const ask = q.ask;
  const chosen = ask === 'loose' ? [...marks.keys()].sort()
    : 'locate' in ask ? ask.locate
    : 'sequence' in ask ? sequence([ask.sequence])
    : ask.children === null ? sequence(root ? [root] : [])
    : sequence(under.get(ask.children) ?? []);
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const start = Math.min(q.cursor ? Number(q.cursor) : 0, chosen.length);
  const end = Math.min(start + limit, chosen.length);
  const entries = chosen.slice(start, end).flatMap((id): OutlineEntry[] => {
    const n = notes.get(id);
    if (!n) return [];
    const e: OutlineEntry = { item: project(n), status: status.get(id)!, hasChildren: Boolean(under.get(id)?.length), marks: marks.get(id) ?? [] };
    if (ask !== 'loose' && 'locate' in ask) {
      e.path = pathOf(id).flatMap((p) => (notes.has(p) ? [project(notes.get(p)!)] : []));
      if (q.subject !== undefined) e.belowSubject = below(id, q.subject);
    }
    return [e];
  });
  return { entries, next: end < chosen.length ? String(end) : null };
}
