import { useCallback, useEffect, useState } from 'react';
import { registry } from 'virtual:gestalts-plugins';
import { RepoProvider } from '@gestalts/client';
import { SingleView, usePluginRepo } from '@gestalts/host';
import css from './app.css?inline';

/**
 * The visualizations of the distribution's decks, one view (`vizint`) at a time. Where it is (which viz, and that
 * viz's params) lives in the URL's hash, so a link opens the same viz in the same state.
 */
const VIEW = 'vizint';

const fromHash = (): Record<string, string> => Object.fromEntries(new URLSearchParams(location.hash.slice(1)));

export function App() {
  const { repo, error } = usePluginRepo({ dir: 'vizint' }, registry);
  const [params, setParams] = useState(fromHash);
  useEffect(() => {
    const onHash = () => setParams(fromHash());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  const onParams = useCallback((p: Record<string, string>) => {
    const hash = `#${new URLSearchParams(p)}`;
    // another viz is a new place to go back from; a viz's own params just update where we are
    if ((p.viz ?? '') !== (fromHash().viz ?? '')) history.pushState(null, '', hash);
    else history.replaceState(null, '', hash);
    setParams(p);
  }, []);
  return (
    <div className="flex h-dvh flex-col bg-base-200">
      <header className="navbar min-h-0 gap-3 border-b border-base-300 bg-base-100 px-4 py-1">
        <a href="#" className="font-semibold">vizint</a>
      </header>
      <main className="min-h-0 flex-1">
        {error && <div role="alert" className="alert alert-error m-4">Could not load: {error}</div>}
        {!error && !repo && <div className="flex justify-center p-8"><span className="loading loading-spinner" /></div>}
        {repo && <RepoProvider repo={repo}><SingleView registry={registry} css={css} view={VIEW} params={params} onParams={onParams} /></RepoProvider>}
      </main>
    </div>
  );
}
