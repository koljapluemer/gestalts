import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { registry } from 'virtual:gestalts-plugins/home';
import { RepoProvider, type Repo } from '@gestalts/client';
import { usePluginRepo, type PluginEntry } from '@gestalts/host';
import { HOME_NODE } from './nodes';

/** The home store: the user's own ymls, in this browser (OPFS), for notes, learning and visualizations alike. */
const DIR = 'home';

type Home = { repo?: Repo; installed: PluginEntry[]; decks: string[]; error?: string };
const EMPTY: Home = { installed: [], decks: [] };
const Context = createContext<{ home: Home; want: () => void }>({ home: EMPTY, want: () => {} });

/**
 * Holds the home store for the whole app, opened the first time an area needs it and kept open from then on, so
 * going between the home areas doesn't read and index everything again.
 */
export function HomeProvider({ children }: { children: ReactNode }) {
  const [wanted, setWanted] = useState(false);
  const [home, setHome] = useState<Home>(EMPTY);
  const want = useCallback(() => setWanted(true), []);
  const value = useMemo(() => ({ home, want }), [home, want]);
  return (
    <Context.Provider value={value}>
      {wanted && <Opener onHome={setHome} />}
      {children}
    </Context.Provider>
  );
}

function Opener({ onHome }: { onHome: (h: Home) => void }) {
  const { repo, installed, decks, error } = usePluginRepo({ dir: DIR, bridge: HOME_NODE }, registry);
  useEffect(() => { onHome({ repo, installed, decks, error }); }, [repo, installed, decks, error, onHome]);
  return null;
}

/** The home store, opening it if it isn't yet. */
export function useHome(): Home {
  const { home, want } = useContext(Context);
  useEffect(want, [want]);
  return home;
}

/** `children` with the home store, once it's open; till then a spinner, or why it couldn't open. */
export function WithHome({ children }: { children: (repo: Repo, home: Home) => ReactNode }) {
  const home = useHome();
  if (home.error) return <div role="alert" className="alert alert-error m-4">Could not open your data: {home.error}</div>;
  if (!home.repo) return <div className="flex h-full items-center justify-center"><span className="loading loading-spinner" /></div>;
  return <RepoProvider repo={home.repo}>{children(home.repo, home)}</RepoProvider>;
}
