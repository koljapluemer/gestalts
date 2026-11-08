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

/** A query's first page as a store React can watch. */
class HostQuery {
  private items: Item[] = [];
  constructor(private repo: Repo, private query: Query) {}
  get = () => this.items;
  subscribe = (notify: () => void) => {
    const { page, stop } = this.repo.live(this.query, () => { this.items = this.repo.query(this.query).items; notify(); });
    this.items = page.items;
    notify();
    return stop;
  };
}

/** The first page of `query`, kept current, for the host's own UI (installs, settings). */
export function useHostQuery(query: Query): Item[] {
  const repo = useHostRepo();
  const key = JSON.stringify(query);
  const store = useMemo(() => new HostQuery(repo, JSON.parse(key) as Query), [repo, key]);
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
