import { useEffect, useState, useSyncExternalStore } from 'react';
import { useRepo } from '@gestalts/sdk';
import { Repo, type RepoSource } from './repo';

/** The host's own repo, with what only the host may do (connect, sync). */
export function useHostRepo(): Repo {
  const repo = useRepo();
  if (!(repo instanceof Repo)) throw new Error('useHostRepo is for the host, inside its own <RepoProvider>');
  return repo;
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
