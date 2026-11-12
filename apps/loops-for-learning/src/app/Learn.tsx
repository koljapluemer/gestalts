import { useState } from 'react';
import { Settings } from 'lucide-react';
import { registry } from 'virtual:gestalts-plugins';
import { RepoProvider } from '@gestalts/client';
import { ConnectorSettings, SingleView, usePluginRepo } from '@gestalts/host';
import css from '../app.css?inline';

/**
 * Every learning view in the distribution (a plugin tagged `learning`), one at a time. Decks are read-only; what the
 * learner does stays in this browser (OPFS) unless they sync it.
 */
const VIEWS = registry.plugins.filter((p) => p.manifest.tags?.includes('learning'));
const LAST_VIEW = 'loops:view';

function lastView(): string | undefined {
  try {
    const v = localStorage.getItem(LAST_VIEW);
    if (v && VIEWS.some((p) => p.manifest.id === v)) return v;
  } catch { /* no storage: the first view */ }
  return VIEWS[0]?.manifest.id;
}

export function Learn() {
  const { repo, error } = usePluginRepo({ dir: 'loops' }, registry);
  const [view, setView] = useState(lastView);
  const choose = (v: string) => {
    setView(v);
    try { localStorage.setItem(LAST_VIEW, v); } catch { /* not remembered */ }
  };
  return (
    <div className="flex h-full flex-col bg-base-200">
      <header className="navbar min-h-0 gap-2 bg-base-100 px-4 py-1 shadow-sm">
        <div role="tablist" className="tabs tabs-border flex-1 overflow-x-auto">
          {VIEWS.length > 1 && VIEWS.map((p) => (
            <button key={p.manifest.id} type="button" role="tab" aria-selected={p.manifest.id === view} className={`tab ${p.manifest.id === view ? 'tab-active' : ''}`} onClick={() => choose(p.manifest.id)}>
              {p.manifest.title}
            </button>
          ))}
        </div>
        {repo && (
          <details className="dropdown dropdown-end">
            <summary className="btn btn-sm btn-ghost btn-square" title="Sync settings"><Settings className="size-4" /></summary>
            <div className="dropdown-content z-50 mt-2 rounded-box border border-base-300 bg-base-100 p-3 shadow">
              <RepoProvider repo={repo}><ConnectorSettings /></RepoProvider>
            </div>
          </details>
        )}
      </header>
      <main className="min-h-0 flex-1">
        {error && <div role="alert" className="alert alert-error m-4">Could not load: {error}</div>}
        {!error && !repo && <div className="flex justify-center p-8"><span className="loading loading-spinner" /></div>}
        {repo && view && <RepoProvider repo={repo}><SingleView key={view} registry={registry} css={css} view={view} /></RepoProvider>}
      </main>
      <footer className="px-4 py-1 text-center text-xs text-base-content/50">Your progress is stored only in this browser, unless you sync it. Pronunciation generated with espeak-ng.</footer>
    </div>
  );
}
