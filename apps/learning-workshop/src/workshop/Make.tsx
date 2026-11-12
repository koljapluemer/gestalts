import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Settings } from 'lucide-react';
import { registry } from 'virtual:gestalts-plugins';
import { RepoProvider, useHostQuery, type Repo } from '@gestalts/client';
import { ConnectorSettings, usePluginRepo } from '@gestalts/host';
import type { ViewError } from '@gestalts/view';
import { Chat } from './Chat';
import { Preview } from './Preview';
import { VIEW, asView, createView, type VibeView } from './workshop';

/**
 * The workshop: views vibecoded into `view@1` ymls, each run in a frame beside the chat that edits it. The ymls live in
 * this browser and sync with the node the workshop runs (`mise run node`, :7727), which runs the claude CLI.
 */
const NODE = import.meta.env.VITE_WORKSHOP_NODE ?? 'http://127.0.0.1:7727';
const SELECTED = 'workshop:view';
const CONNECTED_ONCE = 'workshop:connected-once';

export function Make() {
  const { repo, error } = usePluginRepo({ dir: 'workshop-views' }, registry);
  useEffect(() => {
    if (!repo || repo.connector.get().url) return;
    // the first time only: a later Disconnect is the user's choice
    try {
      if (localStorage.getItem(CONNECTED_ONCE)) return;
      localStorage.setItem(CONNECTED_ONCE, '1');
    } catch { /* not remembered: connect each time */ }
    void repo.connect(NODE);
  }, [repo]);
  return (
    <div className="flex h-full flex-col bg-base-200">
      {error && <div role="alert" className="alert alert-error m-4">Could not load: {error}</div>}
      {!error && !repo && <div className="flex justify-center p-8"><span className="loading loading-spinner" /></div>}
      {repo && <RepoProvider repo={repo}><Shell repo={repo} /></RepoProvider>}
    </div>
  );
}

function Workbench({ repo, view }: { repo: Repo; view: VibeView }) {
  const [errors, setErrors] = useState<ViewError[]>([]);
  const onError = useCallback((e: ViewError) => setErrors((es) => [...es, e].slice(-20)), []);
  return (
    <div className="grid h-full min-h-0 grid-rows-2 md:grid-cols-[minmax(0,1fr)_24rem] md:grid-rows-1">
      <div className="min-h-0 min-w-0"><Preview repo={repo} view={view} onError={onError} /></div>
      <div className="min-h-0 border-t border-base-300 md:border-t-0 md:border-l"><Chat repo={repo} view={view} errors={errors} onTurnDone={() => setErrors([])} /></div>
    </div>
  );
}

function Shell({ repo }: { repo: Repo }) {
  const items = useHostQuery({ gestalt: VIEW, order: { field: 'title' }, limit: 500 });
  const list = useMemo(() => items.map(asView), [items]);
  const [selected, setSelected] = useState<string | null>(() => { try { return localStorage.getItem(SELECTED); } catch { return null; } });
  const choose = (id: string) => {
    setSelected(id);
    try { localStorage.setItem(SELECTED, id); } catch { /* not remembered */ }
  };
  const current = list.find((v) => v.id === selected) ?? null;
  const create = async () => {
    const title = window.prompt('What will it be? (a title; you describe it in the chat next)')?.trim();
    if (title) choose(await createView(repo, title));
  };
  return (
    <>
      <header className="navbar min-h-0 gap-2 bg-base-100 px-4 py-1 shadow-sm">
        <span className="flex-1 truncate text-sm font-medium text-base-content/70">{current?.title ?? 'Make a learning view'}</span>
        <details className="dropdown dropdown-end">
          <summary className="btn btn-sm btn-ghost btn-square" title="Sync settings"><Settings className="size-4" /></summary>
          <div className="dropdown-content z-50 mt-2 rounded-box border border-base-300 bg-base-100 p-3 shadow"><ConnectorSettings /></div>
        </details>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-52 shrink-0 flex-col gap-1 overflow-y-auto border-r border-base-300 bg-base-100 p-2">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void create()}><Plus className="size-4" /> New view</button>
          <ul className="menu menu-sm w-full p-0">
            {list.map((v) => <li key={v.id}><button type="button" className={v.id === current?.id ? 'menu-active' : ''} onClick={() => choose(v.id)}>{v.title || v.id}</button></li>)}
          </ul>
          {!list.length && <p className="p-2 text-sm text-base-content/60">No views yet.</p>}
        </nav>
        <main className="min-w-0 flex-1">
          {current
            ? <Workbench key={current.id} repo={repo} view={current} />
            : <div className="flex h-full items-center justify-center text-base-content/60">Pick a view, or make a new one.</div>}
        </main>
      </div>
    </>
  );
}
