import { useMemo, useState } from 'react';
import { Plus, Settings } from 'lucide-react';
import { registry } from 'virtual:gestalts-plugins/workshop';
import { RepoProvider, useHostQuery, type Repo } from '@gestalts/client';
import { ConnectorSettings, SingleView } from '@gestalts/host';
import { HOME_NODE } from '../nodes';
import css from '../app.css?inline';
import { useDrafts } from '../drafts';
import { Areas } from '../router';
import { Editor } from './Editor';
import { VIZ, asViz, createViz } from './viz';

/**
 * The vizint workshop: vizzes (`viz@1` ymls) each edited beside the `vizint` view showing it, and built from their
 * spec by the claude CLI. The ymls live in this browser and sync with the claude bridge, which runs the agents (`mise run claude-bridge`).
 */
const SELECTED = 'vizint-workshop:viz';
const LIST_LIMIT = 200;

export function Make() {
  const { repo, error } = useDrafts();
  return (
    <div className="flex h-dvh flex-col bg-base-200">
      <header className="navbar min-h-0 gap-3 border-b border-base-300 bg-base-100 px-4 py-1">
        <Areas />
        <span className="font-semibold">vizint workshop</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
      {error && <div role="alert" className="alert alert-error m-4">Could not load: {error}</div>}
      {!error && !repo && <div className="flex justify-center p-8"><span className="loading loading-spinner" /></div>}
      {repo && <RepoProvider repo={repo}><Shell repo={repo} /></RepoProvider>}
      </div>
    </div>
  );
}

const NO_NAVIGATION = () => {};

function Shell({ repo }: { repo: Repo }) {
  const list = useHostQuery({ gestalt: VIZ, fields: ['title'], order: { field: 'title' }, limit: LIST_LIMIT });
  const [selected, setSelected] = useState<string | null>(() => { try { return localStorage.getItem(SELECTED); } catch { return null; } });
  const choose = (id: string | null) => {
    setSelected(id);
    try { if (id) localStorage.setItem(SELECTED, id); else localStorage.removeItem(SELECTED); } catch { /* not remembered */ }
  };
  const current = useHostQuery({ gestalt: VIZ, ids: selected ? [selected] : [], limit: 1 })[0];
  const viz = useMemo(() => (current ? asViz(current) : null), [current]);
  const vizId = viz?.id;
  const params = useMemo(() => {
    const p: Record<string, string> = {};
    if (vizId) p.viz = vizId;
    return p;
  }, [vizId]);
  const create = async () => {
    const title = window.prompt('What will it be? (a title; you write its spec next)')?.trim();
    if (title) choose(await createViz(repo, title));
  };
  return (
    <>
      <header className="navbar min-h-0 gap-2 bg-base-100 px-4 py-1 shadow-sm">
        <span className="flex-1 truncate text-sm font-medium text-base-content/70">{viz?.title ?? 'Make a visualization'}</span>
        <details className="dropdown dropdown-end">
          <summary className="btn btn-sm btn-ghost btn-square" title="Sync settings"><Settings className="size-4" /></summary>
          <div className="dropdown-content z-50 mt-2 rounded-box border border-base-300 bg-base-100 p-3 shadow"><ConnectorSettings defaultUrl={HOME_NODE} /></div>
        </details>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-52 shrink-0 flex-col gap-1 overflow-y-auto border-r border-base-300 bg-base-100 p-2">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void create()}><Plus className="size-4" /> New viz</button>
          <ul className="menu menu-sm w-full p-0">
            {list.map((v) => <li key={v.id}><button type="button" className={v.id === viz?.id ? 'menu-active' : ''} onClick={() => choose(v.id)}>{String(v.value.title ?? '') || v.id}</button></li>)}
          </ul>
          {!list.length && <p className="p-2 text-sm text-base-content/60">No vizzes yet.</p>}
          {list.length >= LIST_LIMIT && <p className="p-2 text-xs text-base-content/60">The first {LIST_LIMIT} by title.</p>}
        </nav>
        <main className="min-w-0 flex-1">
          {viz
            ? (
              <div className="grid h-full min-h-0 grid-rows-2 md:grid-cols-[24rem_minmax(0,1fr)] md:grid-rows-1">
                <div className="min-h-0 border-b border-base-300 md:border-r md:border-b-0">
                  <Editor key={viz.id} repo={repo} viz={viz} onDelete={() => { void repo.delete(viz.id); choose(null); }} />
                </div>
                <div className="min-h-0 min-w-0"><SingleView registry={registry} css={css} view="vizint" params={params} onParams={NO_NAVIGATION} /></div>
              </div>
            )
            : <div className="flex h-full items-center justify-center text-base-content/60">Pick a viz, or make a new one.</div>}
        </main>
      </div>
    </>
  );
}
