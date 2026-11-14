import { createContext, use, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Item, Query } from '@gestalts/view';
import { Repo, type RepoSource } from './repo';

const RepoContext = createContext<Repo | null>(null);

export function RepoProvider({ repo, children }: { repo: Repo; children: ReactNode }) {
  return <RepoContext value={repo}>{children}</RepoContext>;
}

/** The app's repo: for the host's own UI. Views go through the bridge. */
export function useHostRepo(): Repo {
  const repo = use(RepoContext);
  if (!repo) throw new Error('useHostRepo needs a <RepoProvider>');
  return repo;
}

const NONE: Item[] = [];

/**
 * A query's first page as a store React can watch: undefined until it's first answered, then kept current while
 * anyone watches. One per repo and query, so a query the host already follows (installs) is there at once.
 */
class HostQuery {
  private items: Item[] | undefined;
  private listeners = new Set<() => void>();
  private stopLive: (() => void) | undefined;
  /** bumped on each start and stop, so what a stopped round answers late is dropped */
  private round = 0;
  private loaded: Promise<void>;
  private markLoaded: () => void = () => {};
  constructor(private repo: Repo, private query: Query) {
    this.loaded = new Promise((r) => { this.markLoaded = r; });
  }
  get = () => this.items;
  subscribe = (notify: () => void) => {
    this.listeners.add(notify);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(notify);
      if (this.listeners.size) return;
      this.round++;
      this.stopLive?.();
      this.stopLive = undefined;
    };
  };
  /** Settles once the query has been answered. */
  ready = () => this.loaded;
  private set(items: Item[]) {
    this.items = items;
    this.markLoaded();
    this.listeners.forEach((l) => l());
  }
  private start() {
    const round = ++this.round;
    const refresh = () => void this.repo.query(this.query).then((p) => { if (round === this.round) this.set(p.items); }, () => {});
    this.repo.live(this.query, refresh).then(({ page, stop }) => {
      if (round !== this.round) { stop(); return; }
      this.stopLive = stop;
      this.set(page.items);
    }, () => { if (round === this.round) this.set(NONE); });
  }
}

const stores = new WeakMap<Repo, Map<string, HostQuery>>();

function hostQuery(repo: Repo, query: Query): HostQuery {
  let byKey = stores.get(repo);
  if (!byKey) stores.set(repo, (byKey = new Map()));
  const key = JSON.stringify(query);
  let q = byKey.get(key);
  if (!q) byKey.set(key, (q = new HostQuery(repo, query)));
  return q;
}

/**
 * Follows `query` from now on, so `useHostQuery` has its answer at once; settles once it's answered. For what the host
 * needs before showing anything (installs).
 */
export function preloadHostQuery(repo: Repo, query: Query): Promise<void> {
  const q = hostQuery(repo, query);
  q.subscribe(() => {});
  return q.ready();
}

/** The first page of `query`, kept current, for the host's own UI (installs, settings); empty until answered. */
export function useHostQuery(query: Query): Item[] {
  return useHostQueryState(query) ?? NONE;
}

/** As `useHostQuery`, but undefined until the query is first answered. */
export function useHostQueryState(query: Query): Item[] | undefined {
  const repo = useHostRepo();
  const key = JSON.stringify(query);
  const store = useMemo(() => hostQuery(repo, JSON.parse(key) as Query), [repo, key]);
  return useSyncExternalStore(store.subscribe, store.get);
}

export function useConnector() {
  const repo = useHostRepo();
  return useSyncExternalStore(repo.connector.subscribe, repo.connector.get);
}

const SERVICES_POLL_MS = 10_000;

/**
 * The node's services by id, `true` while running: undefined until known, empty without a node. Asked again when
 * the connector changes and every 10 s, since workers start after the page.
 */
export function useServices(): Map<string, boolean> | undefined {
  const repo = useHostRepo();
  const { url } = useConnector();
  const [services, setServices] = useState<Map<string, boolean>>();
  useEffect(() => {
    let live = true;
    const ask = () => void repo.services().then((list) => { if (live) setServices(new Map((list ?? []).map((s) => [s.id, s.available]))); });
    ask();
    const timer = setInterval(ask, SERVICES_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [repo, url]);
  return services;
}

const opened = new Map<string, Promise<Repo>>();

/** Opens a repo once per source (also across StrictMode's double effects); `error` says why it couldn't. */
export function useOpenRepo(source: RepoSource): { repo?: Repo; error?: string } {
  const [state, setState] = useState<{ repo?: Repo; error?: string }>({});
  const key = JSON.stringify(source);
  useEffect(() => {
    let live = true;
    let p = opened.get(key);
    if (!p) {
      p = Repo.open(JSON.parse(key) as RepoSource);
      opened.set(key, p);
    }
    p.then(
      (repo) => { if (live) setState({ repo }); },
      (e: unknown) => { opened.delete(key); if (live) setState({ error: e instanceof Error ? e.message : String(e) }); },
    );
    return () => { live = false; };
  }, [key]);
  return state;
}
