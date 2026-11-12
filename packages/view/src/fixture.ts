import type { ViewHost } from './connection';
import type { Answers, Call, ViewError } from './protocol';
import { outlinePage } from './outline';
import type { Belief, BeliefDelta, Delta, Item, JsonMap, LinkMatch, OutlineDelta, OutlineQuery, Page, Query, Shape } from './types';

const words = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** References as the fixture sees them, knowing no gestalt: items of a list prop with a string `to`. */
function edges(i: Item): { field: string; to: string; label?: string }[] {
  return Object.entries(i.value).flatMap(([field, v]) => (Array.isArray(v) ? v : []).flatMap((r) => (
    r && typeof r === 'object' && !Array.isArray(r) && typeof r.to === 'string' ? [{ field, to: r.to, ...(typeof r.label === 'string' ? { label: r.label } : {}) }] : []
  )));
}

function holds(i: Item | undefined, s: Shape): boolean {
  if (!i) return false;
  const tags = Array.isArray(i.value.tags) ? i.value.tags : [];
  return (s.gestalt === undefined || s.gestalt === i.gestalt)
    && (s.ids === undefined || s.ids.includes(i.id))
    && Object.entries(s.where ?? {}).every(([k, v]) => JSON.stringify(i.value[k]) === JSON.stringify(v))
    && (s.tags?.all ?? []).every((t) => tags.includes(t))
    && !(s.tags?.none ?? []).some((t) => tags.includes(t));
}

function linked(i: Item, m: LinkMatch, all: Map<string, Item>): boolean {
  return edges(i).some((e) => (m.field === undefined || m.field === e.field) && (m.label === undefined || m.label === e.label) && (m.to === undefined || holds(all.get(e.to), m.to)));
}

function matches(i: Item, q: Query, all: Map<string, Item>): boolean {
  const tags = Array.isArray(i.value.tags) ? i.value.tags : [];
  const text = words(JSON.stringify(i.value));
  return (q.gestalt === undefined || q.gestalt === i.gestalt)
    && (q.ids === undefined || q.ids.includes(i.id))
    && Object.entries(q.where ?? {}).every(([k, v]) => JSON.stringify(i.value[k]) === JSON.stringify(v))
    && (q.tags?.all ?? []).every((t) => tags.includes(t))
    && !(q.tags?.none ?? []).some((t) => tags.includes(t))
    && (q.refs === undefined || (q.refs.label === undefined
      ? JSON.stringify(q.refs.field === undefined ? i.value : i.value[q.refs.field] ?? null).includes(JSON.stringify(q.refs.to).slice(1, -1))
      : edges(i).some((e) => e.to === q.refs!.to && e.label === q.refs!.label && (q.refs!.field === undefined || q.refs!.field === e.field))))
    && (q.links?.all ?? []).every((m) => linked(i, m, all))
    && !(q.links?.none ?? []).some((m) => linked(i, m, all))
    && (q.text === undefined || words(q.text).every((w) => text.some((t) => t.startsWith(w))));
}

function page(all: Item[], q: Query): Page {
  const order = q.order;
  const byId = new Map(all.map((i) => [i.id, i]));
  const sorted = all.filter((i) => matches(i, q, byId)).sort((a, b) => {
    if (order && 'field' in order) {
      const [x, y] = [a.value[order.field], b.value[order.field]];
      const c = x === y ? 0 : (x ?? '') < (y ?? '') ? -1 : 1;
      if (c !== 0) return order.desc ? -c : c;
    }
    return a.id < b.id ? -1 : 1;
  });
  const limit = Math.min(q.limit ?? 100, 500);
  const start = q.cursor ? Number(q.cursor) : 0;
  const items = sorted.slice(start, start + limit).map((i) => {
    if (!q.fields) return i;
    const keep = new Set(['id', 'gestalt', ...q.fields]);
    return { ...i, value: Object.fromEntries(Object.entries(i.value).filter(([k]) => keep.has(k))) };
  });
  return { items, next: start + limit < sorted.length ? String(start + limit) : null };
}

export type Fixture = ViewHost & {
  /** the ymls as they are now */
  items(): Item[];
  /** blobs by name */
  blobs: Map<string, Uint8Array>;
  /** the errors the view reported */
  errors: ViewError[];
  /** where the view last put itself (`setParams`) */
  params(): Record<string, string>;
  /** the views it asked to show, in order */
  opened: { view: string; params?: Record<string, string> }[];
  /** moves the view elsewhere, as the app would */
  move(params: Record<string, string>): void;
  /** changes what is believed, as practice elsewhere would */
  setBeliefs(beliefs: Belief[]): void;
};

/** What a fixture says about a concept it has no belief for: the app's prior (no model runs in a fixture). */
const priorBelief = (concept: string): Belief => ({ concept, mean: 0, sd: 1.5, p: 0.5, evidence: 0 });

/**
 * A host that holds `ymls` in memory, for running a view with no app around it: in a test, or in a bare iframe.
 * No model of what the learner knows runs here: `beliefs` are given, and `setBeliefs` changes them.
 */
export function fixtureHost(ymls: JsonMap[] = [], beliefs: Belief[] = []): Fixture {
  const known = new Map(beliefs.map((b) => [b.concept, b]));
  const beliefSubs = new Map<number, { concepts: string[]; listener?: (d: BeliefDelta) => void }>();
  const store = new Map<string, Item>();
  const put = (value: JsonMap) => {
    const id = typeof value.id === 'string' ? value.id : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    const item: Item = { id, gestalt: String(value.gestalt), value: { ...value, id } };
    store.set(id, item);
    return item;
  };
  ymls.forEach(put);
  const blobs = new Map<string, Uint8Array>();
  let params: Record<string, string> = {};
  const opened: { view: string; params?: Record<string, string> }[] = [];
  const moved = new Set<(p: Record<string, string>) => void>();
  const errors: ViewError[] = [];
  const subs = new Map<number, { query: Query; order: string[]; listener?: (d: Delta) => void }>();
  const outlineSubs = new Map<number, { query: OutlineQuery; last: string; listener?: (d: OutlineDelta) => void }>();
  let nextSub = 1;
  const changed = () => {
    for (const [sub, s] of subs) {
      const p = page([...store.values()], s.query);
      const order = p.items.map((i) => i.id);
      if (JSON.stringify(order) === JSON.stringify(s.order) && order.length === 0) continue;
      const remove = s.order.filter((id) => !order.includes(id));
      s.order = order;
      s.listener?.({ sub, upsert: p.items, remove, order, next: p.next });
    }
    for (const [sub, s] of outlineSubs) {
      const p = outlinePage([...store.values()], s.query);
      const now = JSON.stringify(p);
      if (now === s.last) continue;
      s.last = now;
      s.listener?.({ sub, page: p });
    }
  };
  const perform = (c: Call): unknown => {
    switch (c.op) {
      case 'query': return page([...store.values()], c.query);
      case 'subscribe': {
        const sub = nextSub++;
        const p = page([...store.values()], c.query);
        subs.set(sub, { query: c.query, order: p.items.map((i) => i.id) });
        return { sub, page: p };
      }
      case 'beliefs': {
        const sub = nextSub++;
        beliefSubs.set(sub, { concepts: c.concepts });
        return { sub, beliefs: c.concepts.map((id) => known.get(id) ?? priorBelief(id)) };
      }
      case 'outline': {
        const sub = nextSub++;
        const p = outlinePage([...store.values()], c.query);
        outlineSubs.set(sub, { query: c.query, last: JSON.stringify(p) });
        return { sub, page: p };
      }
      case 'unsubscribe': subs.delete(c.sub); beliefSubs.delete(c.sub); outlineSubs.delete(c.sub); return null;
      case 'put': { const item = put(c.value); changed(); return item; }
      case 'delete': { const had = store.delete(c.id); changed(); return had; }
      case 'readBlob': return blobs.get(c.name) ?? null;
      case 'writeBlob': blobs.set(c.name, c.bytes); return null;
      case 'stableId': return `${c.namespace}-${c.name}`;
      case 'stateId': return `${c.gestalt}-${c.target}-${c.facet ?? ''}`;
      case 'contentHash': return Array.from(c.bytes).reduce((h, b) => (Math.imul(31, h) + b) | 0, 0).toString(16);
      case 'service': return { status: 503, contentType: 'text/plain', body: new TextEncoder().encode('no backend in a fixture') };
      case 'net': case 'llm': throw new Error(`${c.op} isn't available in a fixture`);
      case 'capabilities': return { net: false, llm: false, backend: false, microphone: false };
      case 'setState': case 'setTitle': return null;
      case 'setParams': params = c.params; return null;
      // nothing else runs here to show
      case 'openView': opened.push({ view: c.view, ...(c.params ? { params: c.params } : {}) }); return false;
    }
  };
  return {
    call: <C extends Call>(c: C) => { try { return Promise.resolve(perform(c) as Answers[C['op']]); } catch (e) { return Promise.reject(e); } },
    onDelta(sub, f) {
      const s = subs.get(sub);
      if (s) s.listener = f;
      return () => { if (s) s.listener = undefined; };
    },
    onBeliefs(sub, f) {
      const s = beliefSubs.get(sub);
      if (s) s.listener = f;
      return () => { if (s) s.listener = undefined; };
    },
    onOutline(sub, f) {
      const s = outlineSubs.get(sub);
      if (s) s.listener = f;
      return () => { if (s) s.listener = undefined; };
    },
    onParams(f) { moved.add(f); return () => { moved.delete(f); }; },
    report: (e) => { errors.push(e); },
    items: () => [...store.values()],
    blobs,
    errors,
    params: () => params,
    opened,
    move(p) { params = p; moved.forEach((f) => f(p)); },
    setBeliefs(bs) {
      bs.forEach((b) => known.set(b.concept, b));
      for (const [sub, s] of beliefSubs) {
        const changed = bs.filter((b) => s.concepts.includes(b.concept));
        if (changed.length) s.listener?.({ sub, beliefs: changed });
      }
    },
  };
}
