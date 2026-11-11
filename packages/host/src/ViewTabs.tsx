import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Plus, X } from 'lucide-react';
import { useHostRepo, useServices, type Repo } from '@gestalts/client';
import type { JsonMap } from '@gestalts/view';
import { FrameView, type RunnableView } from './frame/FrameView';
import type { ViewEnv } from './frame/bridge';
import { useInstalled } from './installs';
import { findPlugin, type PluginEntry, type Registry } from './registry';
import { closeTab, moveBefore, openTab, routeTo, useTabs, withParams, type Tab } from './tabs';

const subscribeUrl = (l: () => void) => { addEventListener('popstate', l); addEventListener('gestalts:url', l); return () => { removeEventListener('popstate', l); removeEventListener('gestalts:url', l); }; };
const useTabParam = () => useSyncExternalStore(subscribeUrl, () => new URLSearchParams(location.search).get('tab'));

function selectTab(id: string) {
  history.pushState(null, '', `${location.pathname}?tab=${encodeURIComponent(id)}`);
  dispatchEvent(new Event('gestalts:url'));
}

/** Frames kept alive behind the active tab, so going back is instant. Phones hold fewer. */
const KEEP_ALIVE = matchMedia('(max-width: 640px)').matches ? 1 : 4;

const stateKey = (distribution: string, tab: string) => `gestalts-view-state:${distribution}:${tab}`;

function readState(key: string): JsonMap {
  try { return JSON.parse(localStorage.getItem(key) ?? '{}') as JsonMap; } catch { return {}; }
}

function runnable(p: PluginEntry): RunnableView {
  return { id: p.manifest.id, title: p.manifest.title, js: p.js, npm: p.npm, scope: { reads: p.manifest.reads ?? [], writes: p.manifest.writes ?? [], network: p.manifest.network ?? [], llm: p.manifest.llm ?? false, microphone: p.granted.includes('microphone') }, granted: p.granted };
}

const needsBackend = (p: PluginEntry) => (p.manifest.requires ?? []).includes('backend');

/** The view's own backend, through the node. */
function serviceFor(repo: Repo, plugin: string): ViewEnv['service'] {
  return async (path, method, body, contentType) => {
    const r = await repo.service(plugin, path, { method, body: body as BodyInit | undefined, headers: contentType ? { 'content-type': contentType } : undefined });
    if (!r) return { status: 503, contentType: 'text/plain', body: new TextEncoder().encode('no node here') };
    return { status: r.status, contentType: r.headers.get('content-type') ?? '', body: new Uint8Array(await r.arrayBuffer()) };
  };
}

type Navigate = (view: string, params?: Record<string, string>) => boolean;

function ViewFrame({ registry, css, tab, hidden, navigate, setTitle, setParams }: {
  registry: Registry; css: string; tab: Tab; hidden: boolean;
  navigate: Navigate; setTitle: (id: string, title: string) => void; setParams: (id: string, params: Record<string, string>) => void;
}) {
  const repo = useHostRepo();
  const plugin = findPlugin(registry, tab.view);
  const key = stateKey(registry.distribution.id, tab.id);
  const [state] = useState(() => readState(key));
  const env = useMemo<ViewEnv>(() => ({
    service: plugin?.backend ? serviceFor(repo, plugin.manifest.id) : undefined,
    // these ask the node at call time, so connecting later is enough
    net: (r) => repo.net(r),
    llm: (r) => repo.llm(r),
    capabilities: async () => {
      if (!repo.hasNode()) return { net: false, llm: false, backend: false };
      const id = plugin?.manifest.id;
      const [llm, backend] = await Promise.all([
        repo.llmSettings().then((s) => !!s?.providers.some((p) => p.configured), () => false),
        plugin?.backend ? repo.services().then((list) => !!list?.some((s) => s.id === id && s.available), () => false) : false,
      ]);
      return { net: true, llm, backend };
    },
    setState: (s) => { try { localStorage.setItem(key, JSON.stringify(s)); } catch { /* not remembered */ } },
    setTitle: (t) => setTitle(tab.id, t),
    setParams: (p) => setParams(tab.id, p),
    openView: navigate,
  }), [repo, plugin, key, tab.id, setTitle, setParams, navigate]);
  const view = useMemo(() => (plugin ? runnable(plugin) : undefined), [plugin]);
  if (!view) return <p className="p-8 text-center text-base-content/60">This view (<code>{tab.view}</code>) isn't in this app.</p>;
  return <FrameView repo={repo} view={view} runtime={registry.runtime} css={css} params={tab.params} state={state} env={env} hidden={hidden} />;
}

/**
 * The app's views as tabs, this browser's own, in localStorage: opening, closing and moving one never waits on the
 * repo. A view needing a backend this host lacks isn't offered, or is greyed while it isn't running.
 */
export function ViewTabs({ registry, css, title, end }: { registry: Registry; css: string; title: ReactNode; end?: ReactNode }) {
  const installed = useInstalled(registry);
  const services = useServices();
  const [tabs, setTabs] = useTabs(registry.distribution.id, registry.distribution.default_views);
  const param = useTabParam();
  const active = tabs.find((t) => t.id === param) ?? tabs.find((t) => t.view === param) ?? tabs[0];
  const [dragging, setDragging] = useState<string | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});
  // most recently active first
  const [recent, setRecent] = useState<string[]>([]);
  if (active && recent[0] !== active.id) setRecent([active.id, ...recent.filter((id) => id !== active.id)].slice(0, KEEP_ALIVE + 1));

  const open = useCallback((view: string, params?: Record<string, string>) => {
    const r = openTab(tabs, view, params);
    setTabs(r.tabs);
    selectTab(r.id);
  }, [tabs, setTabs]);
  const close = (t: Tab) => {
    const r = closeTab(tabs, t.id);
    setTabs(r.tabs);
    if (active?.id === t.id && r.next) selectTab(r.next);
  };
  const setTitle = useCallback((id: string, t: string) => setTitles((s) => (s[id] === t ? s : { ...s, [id]: t })), []);

  const label = (t: Tab) => titles[t.id] ?? t.title ?? findPlugin(registry, t.view)?.manifest.title ?? t.view;
  const availability = (p: PluginEntry): 'ok' | 'down' | 'missing' => {
    if (!needsBackend(p)) return 'ok';
    const up = services?.get(p.manifest.id);
    return up === undefined ? 'missing' : up ? 'ok' : 'down';
  };
  const offered = installed.filter((p) => availability(p) !== 'missing');
  /** a view asked to show `view` (moved to `params`): in its most recent tab, else a new one; not if it can't run here */
  const navigate = useCallback<Navigate>((view, params) => {
    const p = installed.find((x) => x.manifest.id === view);
    if (!p || availability(p) !== 'ok') return false;
    const r = routeTo(tabs, recent, view, params);
    setTabs(r.tabs);
    selectTab(r.id);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `availability` reads `services`
  }, [tabs, recent, installed, services, setTabs]);
  const setParams = useCallback((id: string, params: Record<string, string>) => {
    setTabs((now) => (JSON.stringify(now.find((t) => t.id === id)?.params) === JSON.stringify(params) ? now : withParams(now, id, params)));
  }, [setTabs]);
  const alive = tabs.filter((t) => recent.includes(t.id) && installed.some((p) => p.manifest.id === t.view));

  return (
    <div className="flex h-dvh flex-col bg-base-200 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
      <nav className="navbar min-h-0 gap-2 border-b border-base-300 bg-base-100 px-3 py-1">
        <span className="hidden font-semibold sm:inline">{title}</span>
        <div className="flex flex-1 items-center gap-1 overflow-x-auto" role="tablist"
             onDragOver={(e) => e.preventDefault()} onDrop={() => { if (dragging) setTabs(moveBefore(tabs, dragging, null)); setDragging(null); }}>
          {tabs.map((t) => (
            <div key={t.id} role="tab" aria-selected={t.id === active?.id} draggable
                 onDragStart={() => setDragging(t.id)} onDragOver={(e) => e.preventDefault()}
                 onDrop={(e) => { e.stopPropagation(); if (dragging && dragging !== t.id) setTabs(moveBefore(tabs, dragging, t.id)); setDragging(null); }}
                 className={`group flex shrink-0 items-center rounded-btn ${t.id === active?.id ? 'bg-base-300' : 'hover:bg-base-200'}`}>
              <button type="button" className="btn btn-sm btn-ghost pr-1" onClick={() => selectTab(t.id)}>{label(t)}</button>
              <button type="button" className="btn btn-ghost btn-xs btn-square opacity-40 group-hover:opacity-100" title="Close" onClick={() => close(t)}><X className="size-3" /></button>
            </div>
          ))}
        </div>
        <details className="dropdown dropdown-end">
          <summary className="btn btn-sm btn-ghost btn-square" title="Open a view"><Plus className="size-4" /></summary>
          <ul className="menu dropdown-content z-50 mt-2 w-56 rounded-box border border-base-300 bg-base-100 p-1 shadow">
            {offered.map((p) => (
              <li key={p.manifest.id} className={availability(p) === 'ok' ? '' : 'menu-disabled'}>
                <button type="button" disabled={availability(p) !== 'ok'} onClick={(e) => { e.currentTarget.closest('details')?.removeAttribute('open'); open(p.manifest.id); }}>{p.manifest.title}</button>
              </li>
            ))}
            {!offered.length && <li className="menu-disabled"><span>No plugin is installed</span></li>}
          </ul>
        </details>
        {end}
      </nav>
      <main className="min-h-0 flex-1">
        {active ? alive.map((t) => <ViewFrame key={t.id} registry={registry} css={css} tab={t} hidden={t.id !== active.id} navigate={navigate} setTitle={setTitle} setParams={setParams} />)
          : <p className="p-8 text-center text-base-content/60">Open a view with +.</p>}
      </main>
    </div>
  );
}

/** One view alone, for apps that show one at a time. */
export function SingleView({ registry, css, view }: { registry: Registry; css: string; view: string }) {
  const [params, setParams] = useState<Record<string, string>>({});
  const tab = useMemo<Tab>(() => ({ id: `single-${view}`, view, params }), [view, params]);
  const noop = useCallback(() => {}, []);
  // there's nowhere else to show
  const navigate = useCallback(() => false, []);
  const move = useCallback((_id: string, p: Record<string, string>) => setParams(p), []);
  return <ViewFrame key={view} registry={registry} css={css} tab={tab} hidden={false} navigate={navigate} setTitle={noop} setParams={move} />;
}
