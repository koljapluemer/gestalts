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
