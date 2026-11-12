import { createContext, use, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ViewHost } from './connection';
import type { Call, Capabilities, LlmRequest, NetReply, NetRequest, ViewInit } from './protocol';
import type { Belief, Item, Json, JsonMap, OutlineAsk, OutlineEntry, OutlinePage, OutlineQuery, OutlineSpec, Page, Query } from './types';

const SAVE_DELAY_MS = 300;

/** What this view keeps across being unloaded; written back shortly after it stops changing. */
class SavedState {
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private host: ViewHost, private state: JsonMap) {}
  has = (key: string) => key in this.state;
  get = (key: string) => this.state[key];
  set(key: string, value: Json) {
    this.state = { ...this.state, [key]: value };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.host.call({ op: 'setState', state: this.state }), SAVE_DELAY_MS);
  }
}

type Params = Record<string, string>;

/** Where this view is: what it started at, then each move by the app and by the view itself. */
class Location {
  private listeners = new Set<() => void>();
  constructor(private host: ViewHost, private params: Params) {}
  get = () => this.params;
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  /** moved by the app */
  moved = (params: Params) => { this.params = params; this.listeners.forEach((l) => l()); };
  /** moved by the view: the app keeps it, so a reload comes back here */
  set = (params: Params) => { this.moved(params); void this.host.call({ op: 'setParams', params }); };
}

type Context = { host: ViewHost; init: ViewInit; blobs: Map<string, Promise<string | null>>; saved: SavedState; location: Location };
const ViewContext = createContext<Context | null>(null);

/** What a view runs inside; the runtime (or a test) provides it. */
export function ViewProvider({ host, init, children }: { host: ViewHost; init: ViewInit; children: ReactNode }) {
  const value = useMemo(() => ({ host, init, blobs: new Map(), saved: new SavedState(host, init.state), location: new Location(host, init.params) }), [host, init]);
  useEffect(() => host.onParams(value.location.moved), [host, value]);
  return <ViewContext value={value}>{children}</ViewContext>;
}

function useContext_(): Context {
  const c = use(ViewContext);
  if (!c) throw new Error('@gestalts/view: this only works inside a view');
  return c;
}

export type QueryResult = {
  items: Item[];
  loading: boolean;
  error?: string;
  /** whether `more` would load anything */
  hasMore: boolean;
  more: () => void;
};

const LOADING: QueryResult = { items: [], loading: true, hasMore: false, more: () => {} };

/** A query kept current: one live subscription per loaded page, stopped when nobody watches. */
class LiveQuery {
  private listeners = new Set<() => void>();
  private pages: { sub: number; items: Map<string, Item>; order: string[]; next: string | null; stop: () => void }[] = [];
  private snapshot = LOADING;
  private generation = 0;
  private busy = false;

  constructor(private host: ViewHost, private query: Query) {}

  get = () => this.snapshot;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(l);
      if (this.listeners.size === 0) this.stop();
    };
  };

  private start() {
    this.snapshot = LOADING;
    this.load(undefined);
  }

  private stop() {
    this.generation++;
    for (const p of this.pages) {
      p.stop();
      void this.host.call({ op: 'unsubscribe', sub: p.sub });
    }
    this.pages = [];
    this.busy = false;
  }

  private more = () => {
    const last = this.pages.at(-1);
    if (last?.next && !this.busy) this.load(last.next);
  };

  private load(cursor: string | undefined) {
    const generation = this.generation;
    this.busy = true;
    this.host.call({ op: 'subscribe', query: { ...this.query, cursor } }).then(({ sub, page }) => {
      if (generation !== this.generation) {
        void this.host.call({ op: 'unsubscribe', sub });
        return;
      }
      this.busy = false;
      this.add(sub, page);
    }, (e: unknown) => {
      if (generation !== this.generation) return;
      this.busy = false;
      this.publish(e instanceof Error ? e.message : String(e));
    });
  }

  private add(sub: number, page: Page) {
    const entry = { sub, items: new Map(page.items.map((i) => [i.id, i])), order: page.items.map((i) => i.id), next: page.next, stop: () => {} };
    entry.stop = this.host.onDelta(sub, (d) => {
      d.remove.forEach((id) => entry.items.delete(id));
      d.upsert.forEach((i) => entry.items.set(i.id, i));
      entry.order = d.order;
      entry.next = d.next;
      this.publish();
    });
    this.pages.push(entry);
    this.publish();
  }

  private publish(error?: string) {
    const seen = new Set<string>();
    const items = this.pages.flatMap((p) => p.order.flatMap((id) => {
      const item = p.items.get(id);
      // an item can move between pages while they load
      if (!item || seen.has(id)) return [];
      seen.add(id);
      return [item];
    }));
    this.snapshot = { items, loading: false, error, hasMore: Boolean(this.pages.at(-1)?.next), more: this.more };
    this.listeners.forEach((l) => l());
  }
}

/**
 * The ymls `query` asks for, kept current. Loads one page; `more()` adds the next. Only changes that concern this
 * query reach it. `null` asks for nothing yet.
 */
export function useQuery(query: Query | null): QueryResult {
  const { host } = useContext_();
  const key = query === null ? null : JSON.stringify(query);
  const live = useMemo(() => (key === null ? null : new LiveQuery(host, JSON.parse(key) as Query)), [host, key]);
  return useSyncExternalStore(live?.subscribe ?? noSubscribe, live?.get ?? idle);
}
const noSubscribe = () => () => {};
const NOTHING: QueryResult = { ...LOADING, loading: false };
const idle = () => NOTHING;

export type BeliefsResult = { beliefs: Map<string, Belief>; loading: boolean; error?: string };

const NO_BELIEFS: BeliefsResult = { beliefs: new Map(), loading: false };
const LOADING_BELIEFS: BeliefsResult = { beliefs: new Map(), loading: true };

/** Beliefs about some concepts kept current: one subscription, stopped when nobody watches. */
class LiveBeliefs {
  private listeners = new Set<() => void>();
  private snapshot = LOADING_BELIEFS;
  private generation = 0;
  private sub: { id: number; stop: () => void } | null = null;

  constructor(private host: ViewHost, private concepts: string[]) {}

  get = () => this.snapshot;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(l);
      if (this.listeners.size === 0) this.stop();
    };
  };

  private start() {
    const generation = ++this.generation;
    this.snapshot = LOADING_BELIEFS;
    this.host.call({ op: 'beliefs', concepts: this.concepts }).then(({ sub, beliefs }) => {
      if (generation !== this.generation) {
        void this.host.call({ op: 'unsubscribe', sub });
        return;
      }
      const map = new Map(beliefs.map((b) => [b.concept, b]));
      const stop = this.host.onBeliefs(sub, (d) => {
        d.beliefs.forEach((b) => map.set(b.concept, b));
        this.publish({ beliefs: new Map(map), loading: false });
      });
      this.sub = { id: sub, stop };
      this.publish({ beliefs: new Map(map), loading: false });
    }, (e: unknown) => {
      if (generation === this.generation) this.publish({ beliefs: new Map(), loading: false, error: e instanceof Error ? e.message : String(e) });
    });
  }

  private stop() {
    this.generation++;
    if (this.sub) {
      this.sub.stop();
      void this.host.call({ op: 'unsubscribe', sub: this.sub.id });
      this.sub = null;
    }
  }

  private publish(r: BeliefsResult) {
    this.snapshot = r;
    this.listeners.forEach((l) => l());
  }
}

/**
 * What is believed about how well the learner knows `concepts` (ids), worked out by the app from all practice and
 * kept current: only changes about these concepts reach the view, never the practice behind them. Every concept asked
 * for gets a belief, at the prior when nothing reached it. `null` asks for nothing yet. The view must read `concept`.
 */
export function useBeliefs(concepts: string[] | null): BeliefsResult {
  const { host } = useContext_();
  const key = concepts === null ? null : JSON.stringify([...new Set(concepts)].sort());
  const live = useMemo(() => (key === null ? null : new LiveBeliefs(host, JSON.parse(key) as string[])), [host, key]);
  return useSyncExternalStore(live?.subscribe ?? noSubscribe, live?.get ?? idleBeliefs);
}
const idleBeliefs = () => NO_BELIEFS;

export type OutlineResult = {
  entries: OutlineEntry[];
  loading: boolean;
  error?: string;
  /** whether `more` would load anything */
  hasMore: boolean;
  more: () => void;
};

const LOADING_OUTLINE: OutlineResult = { entries: [], loading: true, hasMore: false, more: () => {} };

/** An outline's answer kept current: one subscription per loaded page, each page replaced whole when it changes. */
class LiveOutline {
  private listeners = new Set<() => void>();
  private pages: { sub: number; page: OutlinePage; stop: () => void }[] = [];
  private snapshot = LOADING_OUTLINE;
  private generation = 0;
  private busy = false;

  constructor(private host: ViewHost, private query: OutlineQuery) {}

  get = () => this.snapshot;

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    if (this.listeners.size === 1) { this.snapshot = LOADING_OUTLINE; this.load(undefined); }
    return () => {
      this.listeners.delete(l);
      if (this.listeners.size === 0) this.stop();
    };
  };

  private stop() {
    this.generation++;
    for (const p of this.pages) {
      p.stop();
      void this.host.call({ op: 'unsubscribe', sub: p.sub });
    }
    this.pages = [];
    this.busy = false;
  }

  private more = () => {
    const last = this.pages.at(-1);
    if (last?.page.next && !this.busy) this.load(last.page.next);
  };

  private load(cursor: string | undefined) {
    const generation = this.generation;
    this.busy = true;
    this.host.call({ op: 'outline', query: { ...this.query, ...(cursor === undefined ? {} : { cursor }) } }).then(({ sub, page }) => {
      if (generation !== this.generation) {
        void this.host.call({ op: 'unsubscribe', sub });
        return;
      }
      this.busy = false;
      const entry = { sub, page, stop: () => {} };
      entry.stop = this.host.onOutline(sub, (d) => { entry.page = d.page; this.publish(); });
      this.pages.push(entry);
      this.publish();
    }, (e: unknown) => {
      if (generation !== this.generation) return;
      this.busy = false;
      this.publish(e instanceof Error ? e.message : String(e));
    });
  }

  private publish(error?: string) {
    const seen = new Set<string>();
    // a yml can move between pages while they load
    const entries = this.pages.flatMap((p) => p.page.entries.filter((e) => !seen.has(e.item.id) && seen.add(e.item.id)));
    this.snapshot = { entries, loading: false, error, hasMore: Boolean(this.pages.at(-1)?.page.next), more: this.more };
    this.listeners.forEach((l) => l());
  }
}

/**
 * What an outline (see `OutlineSpec`) answers to `ask`, kept current: the rows under a yml (`{children: id}`, the top
 * level for `null`), a yml and what follows it (`{sequence: id}`), where some ymls are (`{locate: ids}`, with
 * `belowSubject` when `subject` is given), or every yml that doesn't add up (`'loose'`). Loads one page; `more()` adds
 * the next. `null` asks for nothing yet. The view must read the spec's gestalt.
 */
export function useOutline(spec: OutlineSpec, ask: OutlineAsk | null, options: { limit?: number; fields?: string[]; subject?: string } = {}): OutlineResult {
  const { host } = useContext_();
  const key = ask === null ? null : JSON.stringify({ spec, ask, ...options });
  const live = useMemo(() => (key === null ? null : new LiveOutline(host, JSON.parse(key) as OutlineQuery)), [host, key]);
  return useSyncExternalStore(live?.subscribe ?? noSubscribe, live?.get ?? idleOutline);
}
const IDLE_OUTLINE: OutlineResult = { entries: [], loading: false, hasMore: false, more: () => {} };
const idleOutline = () => IDLE_OUTLINE;

/** One yml by id, kept current; `undefined` while loading or when there's none. */
export function useDoc(gestalt: string, id: string | null): Item | undefined {
  return useQuery(id === null ? null : { gestalt, ids: [id], limit: 1 }).items[0];
}

/**
 * Reading ymls once, not kept current: for a check or an action (is this key taken? export everything), not for what
 * the view shows, which is `useQuery`'s.
 */
export function useRead() {
  const { host } = useContext_();
  return useMemo(() => ({
    page: (query: Query) => host.call({ op: 'query', query }),
    /** Every page of `query`, one after another. */
    all: async (query: Query) => {
      const items: Item[] = [];
      let cursor: string | undefined;
      do {
        const page = await host.call({ op: 'query', query: { ...query, limit: 500, ...(cursor ? { cursor } : {}) } });
        items.push(...page.items);
        cursor = page.next ?? undefined;
      } while (cursor);
      return items;
    },
  }), [host]);
}

/** Writing ymls and blobs. A yml must be valid by its gestalt, or the promise rejects saying why. */
export function useWrite() {
  const { host } = useContext_();
  return useMemo(() => ({
    /** Without an `id`, it gets a new one. */
    put: (value: JsonMap) => host.call({ op: 'put', value }),
    remove: (id: string) => host.call({ op: 'delete', id }),
    writeBlob: (name: string, bytes: Uint8Array) => host.call({ op: 'writeBlob', name, bytes }),
    readBlob: (name: string) => host.call({ op: 'readBlob', name }),
    contentHash: (bytes: Uint8Array) => host.call({ op: 'contentHash', bytes }),
    /** The same id for the same `name` within `namespace`. */
    stableId: (namespace: string, name: string) => host.call({ op: 'stableId', namespace, name }),
    /** The id of a learner-state yml for `target`, or one `facet` of it. */
    stateId: (gestalt: string, target: string, facet?: string) => host.call({ op: 'stateId', gestalt, target, facet }),
  }), [host]);
}

const MIME: Record<string, string> = {
  webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf',
};

/** URLs for the blobs named, filled in as they load. */
export function useBlobUrls(names: string[]): Record<string, string> {
  const { host, blobs } = useContext_();
  const [urls, setUrls] = useState<Record<string, string>>({});
  const key = names.join('\n');
  useEffect(() => {
    let live = true;
    for (const name of key ? key.split('\n') : []) {
      let p = blobs.get(name);
      if (!p) {
        p = host.call({ op: 'readBlob', name }).then((bytes) => {
          if (!bytes) { blobs.delete(name); return null; }
          const type = MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
          return URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
        });
        blobs.set(name, p);
      }
      void p.then((url) => { if (live && url) setUrls((u) => (u[name] === url ? u : { ...u, [name]: url })); });
    }
    return () => { live = false; };
  }, [host, blobs, key]);
  return urls;
}

/** A URL for a blob, usable in `src`; `undefined` while loading or if there's none. */
export function useBlobUrl(name: string | undefined): string | undefined {
  const urls = useBlobUrls(name ? [name] : []);
  return name ? urls[name] : undefined;
}

/**
 * State that survives this view being closed and reopened, or its tab being unloaded. Keep it small: what the view
 * was showing, not data.
 */
export function useViewState<T extends Json>(key: string, initial: T): [T, (value: T) => void] {
  const { saved } = useContext_();
  const [value, setValue] = useState<T>(() => (saved.has(key) ? (saved.get(key) as T) : initial));
  const set = useMemo(() => (next: T) => { setValue(next); saved.set(key, next); }, [saved, key]);
  return [value, set];
}

/**
 * Where this view is, like a URL: what it shows that another view could send it to (`openView`), kept across reloads.
 * It changes when the app moves the view, and with the setter. What isn't a place (a search box) belongs in
 * `useViewState`.
 */
export function useParams(): [Params, (params: Params) => void] {
  const { location } = useContext_();
  return [useSyncExternalStore(location.subscribe, location.get), location.set];
}

/** This plugin's `backend.py`, where the app has one. `path` as in its routes. */
export function useService() {
  const { host } = useContext_();
  return useMemo(() => async <T = unknown>(path: string, body?: Json, method = 'POST'): Promise<T> => {
    const call: Call = { op: 'service', path, method, ...(body === undefined ? {} : { body: JSON.stringify(body), contentType: 'application/json' }) };
    const r = await host.call(call as Extract<Call, { op: 'service' }>);
    const text = new TextDecoder().decode(r.body);
    if (r.status >= 400) throw new Error(text || `the backend answered ${r.status}`);
    return JSON.parse(text) as T;
  }, [host]);
}

export type NetResponse = NetReply & { text(): string };

/** HTTP to the hosts this view's manifest lists in `network`, through the app (so no CORS). Refusals throw. */
export function useNet() {
  const { host } = useContext_();
  return useMemo(() => async (request: NetRequest): Promise<NetResponse> => {
    const r = await host.call({ op: 'net', request });
    return { ...r, text: () => new TextDecoder().decode(r.body) };
  }, [host]);
}

/** A completion from the user's LLM providers (manifest: `llm: true`). Throws, saying why, when none answers. */
export function useLlm() {
  const { host } = useContext_();
  return useMemo(() => (request: LlmRequest) => host.call({ op: 'llm', request }), [host]);
}

/** Whether `useNet`, `useLlm` and (for an optional backend) `useService` work here; undefined until the app has said. */
export function useCapabilities(): { capabilities: Capabilities | undefined; refresh: () => void } {
  const { host } = useContext_();
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    host.call({ op: 'capabilities' }).then((c) => { if (live) setCapabilities(c); }, () => { if (live) setCapabilities({ net: false, llm: false, backend: false, microphone: false }); });
    return () => { live = false; };
  }, [host, round]);
  return { capabilities, refresh: useMemo(() => () => setRound((r) => r + 1), []) };
}

/** Who this view is, and what it can ask of the app around it. */
export function useHost() {
  const { host, init } = useContext_();
  return useMemo(() => ({
    id: init.id,
    title: init.title,
    setTitle: (title: string) => { void host.call({ op: 'setTitle', title }); },
    /** Shows `view` (its most recent tab, moved to `params` if given); whether the app could, as it may lack that view. */
    openView: (view: string, params?: Params): Promise<boolean> => host.call({ op: 'openView', view, ...(params ? { params } : {}) }),
  }), [host, init]);
}
