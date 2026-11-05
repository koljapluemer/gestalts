import { createElement, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Plus, X } from 'lucide-react';
import { setUrlParams, subscribeUrl } from '@gestalts/kit';
import { useHostRepo, useServices } from '@gestalts/client';
import { ErrorBoundary } from '../debug';
import { useInstalled } from './installs';
import { PaneFrame } from './PaneFrame';
import { paneSupport, supportText, type PaneSupport } from './panes';
import { entryComponent, findPane, paneRef, type Registry } from './registry';
import { closeTab, moveBefore, openTab, useTabs, type Tab } from './tabs';

/** The selected tab, in the URL (`?pane=`), so reloads and links keep it. */
function usePaneParam(): string | null {
  return useSyncExternalStore(subscribeUrl, () => new URLSearchParams(location.search).get('pane'));
}

function selectPane(id: string) {
  // a fresh query string: other params belong to the previous pane
  history.pushState(null, '', `${location.pathname}?pane=${encodeURIComponent(id)}`);
  setUrlParams({});
}

/** How well this host runs the pane at `ref`; a pane of a plugin it doesn't have counts as fine (the view says why not). */
function useSupport(registry: Registry): (ref: string) => PaneSupport {
  const services = useServices();
  return (ref) => { const found = findPane(registry, ref); return found ? paneSupport(found.pane, services) : { state: 'ok' }; };
}

/**
 * The app's panes as tabs. They are this browser's own, per distribution, in localStorage (`tabs.ts`): not notes, so
 * opening, closing and moving one never waits on the repo. Each tab is an instance of a pane with its own `params`,
 * so a pane can be open more than once. Without any stored, the distribution's default panes are the tabs.
 * Tabs can be opened (+), closed (×) and dragged into another order. A pane needing a service this host lacks isn't
 * offered, or greyed while the service isn't running.
 */
export function PaneTabs({ registry, title, end }: { registry: Registry; title: ReactNode; end?: ReactNode }) {
  const installed = useInstalled(registry);
  const [tabs, setTabs] = useTabs(registry.distribution.id, registry.distribution.default_panes);
  const support = useSupport(registry);

  const param = usePaneParam();
  // a tab id, or (from links) a pane ref or id
  const active = tabs.find((t) => t.id === param) ?? tabs.find((t) => param && (t.pane === param || t.pane.endsWith(`/${param}`))) ?? tabs[0];
  const [dragging, setDragging] = useState<string | null>(null);

  const open = (ref: string) => {
    const r = openTab(tabs, ref);
    setTabs(r.tabs);
    selectPane(r.id);
  };
  const close = (t: Tab) => {
    const r = closeTab(tabs, t.id);
    setTabs(r.tabs);
    if (active?.id === t.id && r.next) selectPane(r.next);
  };
  const move = (id: string, before: string | null) => setTabs(moveBefore(tabs, id, before));
  const navigate = (ref: string, params?: Record<string, string>) => {
    const existing = tabs.find((t) => t.pane === ref);
    if (existing) selectPane(existing.id);
    else open(ref);
    if (params) setUrlParams(params);
  };

  const available = installed.flatMap((p) => (p.manifest.panes ?? []).map((pane) => ({ ref: paneRef(p.manifest.id, pane.id), title: pane.title })))
    .map((a) => ({ ...a, support: support(a.ref) }))
    .filter((a) => a.support.state !== 'missing');
  const label = (t: Tab) => t.title ?? findPane(registry, t.pane)?.pane.title ?? t.pane;

  return (
    <div className="flex h-dvh flex-col bg-base-200">
      <nav className="navbar min-h-0 gap-2 border-b border-base-300 bg-base-100 px-3 py-1">
        <span className="font-semibold">{title}</span>
        <div className="flex flex-1 items-center gap-1 overflow-x-auto" role="tablist"
             onDragOver={(e) => e.preventDefault()} onDrop={() => { if (dragging) move(dragging, null); setDragging(null); }}>
          {tabs.map((t) => { const why = supportText(support(t.pane)); return (
            <div key={t.id} role="tab" aria-selected={t.id === active?.id} draggable title={why}
                 onDragStart={() => setDragging(t.id)}
                 onDragOver={(e) => e.preventDefault()}
                 onDrop={(e) => { e.stopPropagation(); if (dragging && dragging !== t.id) move(dragging, t.id); setDragging(null); }}
                 className={`group flex shrink-0 items-center rounded-btn ${t.id === active?.id ? 'bg-base-300' : 'hover:bg-base-200'} ${why ? 'opacity-60' : ''}`}>
              <button type="button" className="btn btn-sm btn-ghost pr-1" onClick={() => selectPane(t.id)}>{label(t)}</button>
              <button type="button" className="btn btn-ghost btn-xs btn-square opacity-40 group-hover:opacity-100" title="Close" onClick={() => close(t)}>
                <X className="size-3" />
              </button>
            </div>
          ); })}
          <details className="dropdown">
            <summary className="btn btn-sm btn-ghost btn-square" title="Open a pane"><Plus className="size-4" /></summary>
            <ul className="menu dropdown-content z-50 mt-2 w-56 rounded-box border border-base-300 bg-base-100 p-1 shadow">
              {available.map((a) => (
                <li key={a.ref} className={a.support.state === 'ok' ? '' : 'menu-disabled'} title={supportText(a.support)}>
                  <button type="button" disabled={a.support.state !== 'ok'} onClick={() => open(a.ref)}>{a.title}</button>
                </li>
              ))}
              {!available.length && <li className="menu-disabled"><span>No plugin with panes is installed</span></li>}
            </ul>
          </details>
        </div>
        {end}
      </nav>
      <main className="min-h-0 flex-1">
        {active ? <PaneView key={active.id} registry={registry} tab={active} navigate={navigate} /> : <p className="p-8 text-center text-base-content/60">Open a pane with +.</p>}
      </main>
    </div>
  );
}

function PaneView({ registry, tab, navigate }: { registry: Registry; tab: Tab; navigate: (ref: string, params?: Record<string, string>) => void }) {
  const repo = useHostRepo();
  const installed = useInstalled(registry);
  const found = findPane(registry, tab.pane);
  const why = supportText(useSupport(registry)(tab.pane));
  if (!found || !installed.includes(found.plugin)) {
    return <p className="p-8 text-center text-base-content/60">This pane (<code>{tab.pane}</code>) is from a plugin that isn't installed here.</p>;
  }
  return (
    <ErrorBoundary name={found.pane.title}>
      <WithBanner text={why}>
        <PaneFrame repo={repo} plugins={installed} plugin={found.plugin} navigate={navigate} setTitle={(t) => { document.title = t; }}>
          {createElement(entryComponent<{ params: Record<string, string> }>(found.plugin, found.pane.entry), { params: tab.params })}
        </PaneFrame>
      </WithBanner>
    </ErrorBoundary>
  );
}

/** One pane alone, for apps without tabs (the Demo). */
export function SinglePane({ registry, paneRef: ref }: { registry: Registry; paneRef: string }) {
  const repo = useHostRepo();
  const installed = useInstalled(registry);
  const found = findPane(registry, ref);
  const why = supportText(useSupport(registry)(ref));
  if (!found) return <p className="p-8 text-center">No pane {ref}.</p>;
  return (
    <ErrorBoundary name={found.pane.title}>
      <WithBanner text={why}>
        <PaneFrame repo={repo} plugins={installed} plugin={found.plugin}>
          {createElement(entryComponent<{ params: Record<string, string> }>(found.plugin, found.pane.entry), { params: {} })}
        </PaneFrame>
      </WithBanner>
    </ErrorBoundary>
  );
}

/** A pane under a line saying what it lacks here; the pane keeps the rest of the height. */
function WithBanner({ text, children }: { text?: string; children: ReactNode }) {
  if (!text) return children;
  return (
    <div className="flex h-full flex-col">
      <div role="status" className="alert alert-warning rounded-none py-1 text-sm">{text}</div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
