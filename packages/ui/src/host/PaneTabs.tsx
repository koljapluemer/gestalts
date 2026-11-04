import { createElement, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Plus, X } from 'lucide-react';
import { asMap, newId, useQuery } from '@gestalts/sdk';
import { setUrlParams, subscribeUrl } from '@gestalts/kit';
import { useHostRepo, useServices } from '@gestalts/client';
import { ErrorBoundary } from '../debug';
import { useInstalled } from './installs';
import { PaneFrame } from './PaneFrame';
import { defaultPaneKey, ownPanes, paneSupport, paneValue, supportText, unclaimedPanes, type PaneNote, type PaneSupport } from './panes';
import { entryComponent, findPane, paneRef, type Registry } from './registry';

const SEEDED_AT = '1970-01-01T00:00:00.000Z';
const now = () => new Date().toISOString();

/** The selected pane note, in the URL (`?pane=`), so reloads and links keep it. */
function usePaneParam(): string | null {
  return useSyncExternalStore(subscribeUrl, () => new URLSearchParams(location.search).get('pane'));
}

function selectPane(key: string) {
  // a fresh query string: other params belong to the previous pane
  history.pushState(null, '', `${location.pathname}?pane=${encodeURIComponent(key)}`);
  setUrlParams({});
}

/** How well this host runs the pane at `ref`; a pane of a plugin it doesn't have counts as fine (the view says why not). */
function useSupport(registry: Registry): (ref: string) => PaneSupport {
  const services = useServices();
  return (ref) => { const found = findPane(registry, ref); return found ? paneSupport(found.pane, services) : { state: 'ok' }; };
}

/**
 * The app's panes as tabs, one per `pane@1` note of this distribution: they sync and merge like any other note, and
 * another distribution (a phone's) keeps tabs of its own. Without any, the distribution's default panes are seeded.
 * Tabs can be opened (+), closed (×) and dragged into another order. A pane needing a service this host lacks isn't
 * offered, or greyed while the service isn't running.
 */
export function PaneTabs({ registry, title, end }: { registry: Registry; title: ReactNode; end?: ReactNode }) {
  const repo = useHostRepo();
  const installed = useInstalled(registry);
  const notes = useQuery({ gestalt: 'pane@1' });
  const dist = registry.distribution.id;
  const panes = useMemo(() => ownPanes(notes, dist), [notes, dist]);
  const unclaimed = useMemo(() => unclaimedPanes(notes), [notes]);
  const support = useSupport(registry);
  const seeding = useRef(false);
  useEffect(() => {
    if (seeding.current) return;
    // the repo has synced once by now (usePluginRepo waits for it), so what's missing is really missing
    if (unclaimed.length) {
      // tabs from before distributions: the first tab host to see them takes them
      seeding.current = true;
      void Promise.all(unclaimed.map((n) => repo.putValue(n.key, { ...asMap(n.value), distribution: dist }))).finally(() => { seeding.current = false; });
      return;
    }
    if (panes.length) return;
    const defaults = registry.distribution.default_panes.map((ref, i) => ({ ref, key: defaultPaneKey(dist, ref), order: i }));
    if (defaults.some((d) => repo.isDeleted(d.key))) return; // closed on purpose before: no reseeding
    seeding.current = true;
    void Promise.all(defaults.map((d) => repo.putValue(d.key, paneValue(d.key, dist, d.ref, d.order, SEEDED_AT))));
  }, [panes.length, unclaimed, registry, dist, repo]);

  const param = usePaneParam();
  // a key, or (from older links) a pane id
  const active = panes.find((p) => p.key === param) ?? panes.find((p) => param && (p.ref === param || p.ref.endsWith(`/${param}`))) ?? panes[0];
  const [dragging, setDragging] = useState<string | null>(null);

  const open = async (ref: string) => {
    const key = newId();
    const order = (panes.at(-1)?.order ?? 0) + 1;
    await repo.putValue(key, paneValue(key, dist, ref, order, now()));
    selectPane(key);
  };
  const close = async (p: PaneNote) => {
    const i = panes.indexOf(p);
    await repo.delete(p.key);
    if (active?.key === p.key) {
      const next = panes[i + 1] ?? panes[i - 1];
      if (next) selectPane(next.key);
    }
  };
  const moveBefore = async (key: string, before: PaneNote | null) => {
    const rest = panes.filter((p) => p.key !== key);
    const i = before ? rest.indexOf(before) : rest.length;
    const prev = rest[i - 1]?.order;
    const next = rest[i]?.order;
    const order = prev === undefined ? (next ?? 0) - 1 : next === undefined ? prev + 1 : (prev + next) / 2;
    const n = repo.get(key);
    if (!n) return;
    await repo.putValue(key, { ...asMap(n.value), position: { order, at: now() } });
  };
  const navigate = (ref: string, params?: Record<string, string>) => {
    const existing = panes.find((p) => p.ref === ref);
    if (existing) { selectPane(existing.key); if (params) setUrlParams(params); }
    else void open(ref).then(() => params && setUrlParams(params));
  };

  const available = installed.flatMap((p) => (p.manifest.panes ?? []).map((pane) => ({ ref: paneRef(p.manifest.id, pane.id), title: pane.title })))
    .map((a) => ({ ...a, support: support(a.ref) }))
    .filter((a) => a.support.state !== 'missing');
  const label = (p: PaneNote) => p.title ?? findPane(registry, p.ref)?.pane.title ?? p.ref;

  return (
    <div className="flex h-dvh flex-col bg-base-200">
      <nav className="navbar min-h-0 gap-2 border-b border-base-300 bg-base-100 px-3 py-1">
        <span className="font-semibold">{title}</span>
        <div className="flex flex-1 items-center gap-1 overflow-x-auto" role="tablist"
             onDragOver={(e) => e.preventDefault()} onDrop={() => { if (dragging) void moveBefore(dragging, null); setDragging(null); }}>
          {panes.map((p) => { const why = supportText(support(p.ref)); return (
            <div key={p.key} role="tab" aria-selected={p.key === active?.key} draggable title={why}
                 onDragStart={() => setDragging(p.key)}
                 onDragOver={(e) => e.preventDefault()}
                 onDrop={(e) => { e.stopPropagation(); if (dragging && dragging !== p.key) void moveBefore(dragging, p); setDragging(null); }}
                 className={`group flex shrink-0 items-center rounded-btn ${p.key === active?.key ? 'bg-base-300' : 'hover:bg-base-200'} ${why ? 'opacity-60' : ''}`}>
              <button type="button" className="btn btn-sm btn-ghost pr-1" onClick={() => selectPane(p.key)}>{label(p)}</button>
              <button type="button" className="btn btn-ghost btn-xs btn-square opacity-40 group-hover:opacity-100" title="Close" onClick={() => void close(p)}>
                <X className="size-3" />
              </button>
            </div>
          ); })}
          <details className="dropdown">
            <summary className="btn btn-sm btn-ghost btn-square" title="Open a pane"><Plus className="size-4" /></summary>
            <ul className="menu dropdown-content z-50 mt-2 w-56 rounded-box border border-base-300 bg-base-100 p-1 shadow">
              {available.map((a) => (
                <li key={a.ref} className={a.support.state === 'ok' ? '' : 'menu-disabled'} title={supportText(a.support)}>
                  <button type="button" disabled={a.support.state !== 'ok'} onClick={() => void open(a.ref)}>{a.title}</button>
                </li>
              ))}
              {!available.length && <li className="menu-disabled"><span>No plugin with panes is installed</span></li>}
            </ul>
          </details>
        </div>
        {end}
      </nav>
      <main className="min-h-0 flex-1">
        {active ? <PaneView key={active.key} registry={registry} pane={active} navigate={navigate} /> : <p className="p-8 text-center text-base-content/60">Open a pane with +.</p>}
      </main>
    </div>
  );
}

function PaneView({ registry, pane, navigate }: { registry: Registry; pane: PaneNote; navigate: (ref: string, params?: Record<string, string>) => void }) {
  const repo = useHostRepo();
  const installed = useInstalled(registry);
  const found = findPane(registry, pane.ref);
  const why = supportText(useSupport(registry)(pane.ref));
  if (!found || !installed.includes(found.plugin)) {
    return <p className="p-8 text-center text-base-content/60">This pane (<code>{pane.ref}</code>) is from a plugin that isn't installed here.</p>;
  }
  return (
    <ErrorBoundary name={found.pane.title}>
      <WithBanner text={why}>
        <PaneFrame repo={repo} plugins={installed} plugin={found.plugin} navigate={navigate} setTitle={(t) => { document.title = t; }}>
          {createElement(entryComponent<{ params: Record<string, string> }>(found.plugin, found.pane.entry), { params: pane.params })}
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
