import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { HostProvider, RepoProvider, type Host, type HostLens, type Lens, type Query, type SlotProps } from '@gestalts/sdk';
import { Modal, Note, NotePicker } from '@gestalts/kit';
import type { Repo } from '@gestalts/client';
import { ErrorBoundary } from '../debug';
import { useOverlay } from './overlay';
import { entryComponent, entryExport, type PluginEntry, type Scope } from './registry';
import { scopedRepo } from './scoped';

type Props = {
  /** the host's own repo */
  repo: Repo;
  /** the installed plugins, for slot views */
  plugins: PluginEntry[];
  /** whose code runs inside: its access scopes the repo it gets */
  plugin: PluginEntry;
  navigate?: Host['navigate'];
  setTitle?: Host['setTitle'];
  children: ReactNode;
};

/**
 * Where a plugin's pane runs: the host's capabilities (a note, or a new one, over the pane; a note picker; slots;
 * the plugins' lenses) and the repo scoped to the plugin's `access`. The notes over the pane are the host's, so they
 * get the host's repo.
 */
export function PaneFrame({ repo, plugins, plugin, navigate, setTitle, children }: Props) {
  const [overlay, overlays] = useOverlay();
  const [picking, setPicking] = useState<{ query: Query; title?: string; resolve: (key: string | null) => void } | null>(null);
  // who waits for the new note over the pane (a reload loses them: the note is still created, nobody hears of it)
  const creating = useRef<((key: string | null) => void) | null>(null);
  const slot = useSlots(repo, plugins);
  const lenses = useLenses(repo, plugins);
  const host = useMemo<Host>(() => ({
    openNote: (key) => overlays.open({ kind: 'note', key }),
    createNote: (seed = {}) => new Promise((resolve) => {
      creating.current?.(null);
      creating.current = resolve;
      overlays.open({ kind: 'new', seed });
    }),
    pickNote: (query, title) => new Promise((resolve) => setPicking({ query, title, resolve })),
    navigate,
    setTitle,
    slot,
    lenses,
  }), [overlays, navigate, setTitle, slot, lenses]);
  const created = (key: string | null) => {
    const resolve = creating.current;
    creating.current = null;
    // cleared in place: the caller may open the note next
    overlays.replace(null);
    resolve?.(key);
  };
  const scoped = useMemo(() => scopedRepo(repo, plugin.manifest.id, plugin.manifest.access), [repo, plugin]);
  const pick = (key: string | null) => { picking?.resolve(key); setPicking(null); };
  return (
    <HostProvider host={host}>
      <RepoProvider repo={scoped}>
        <Suspense fallback={<div className="flex justify-center p-8"><span className="loading loading-spinner" /></div>}>{children}</Suspense>
      </RepoProvider>
      {overlay && (
        <Modal onClose={overlay.kind === 'new' ? () => created(null) : overlays.close}>
          {overlay.kind === 'note'
            ? <Note key={overlay.key} noteKey={overlay.key} persist={`modal:${overlay.key}`} autofocus onClose={overlays.close} onDeleted={overlays.close}
                    onOpen={(key) => overlays.open({ kind: 'note', key })} className="p-3" />
            : <Note key={JSON.stringify(overlay.seed)} seed={overlay.seed} autofocus onCreated={created} onCancel={() => created(null)} className="p-3" />}
        </Modal>
      )}
      {picking && (
        <Modal onClose={() => pick(null)}>
          <div className="flex flex-col gap-2 p-4">
            {picking.title && <h2 className="font-semibold">{picking.title}</h2>}
            <NotePicker query={picking.query} autofocus onPick={pick} />
          </div>
        </Modal>
      )}
    </HostProvider>
  );
}

/** The installed plugins' lenses, as they load; each `afterSave` runs with its plugin's access. */
function useLenses(repo: Repo, plugins: PluginEntry[]): HostLens[] {
  const [lenses, setLenses] = useState<HostLens[]>([]);
  useEffect(() => {
    let live = true;
    const wanted = plugins.flatMap((p) => (p.manifest.lenses ?? []).map((l) => ({ p, l })));
    void Promise.all(wanted.map(async ({ p, l }): Promise<HostLens | null> => {
      try {
        const lens = await entryExport<Lens>(p, l.entry);
        if (lens.gestalt !== l.gestalt) throw new Error(`its lens at ${l.entry} is for ${lens.gestalt}, not ${l.gestalt}`);
        const scoped = scopedRepo(repo, p.manifest.id, p.manifest.access as { read?: Scope; write?: Scope });
        const { afterSave, ...rest } = lens;
        return afterSave ? { ...rest, afterSave: (ctx) => afterSave(scoped, ctx) } : rest;
      } catch (e) {
        console.error(`${p.manifest.id}: lens for ${l.gestalt} not loaded`, e);
        return null;
      }
    })).then((loaded) => { if (live) setLenses(loaded.filter((l): l is HostLens => l !== null)); });
    return () => { live = false; };
  }, [repo, plugins]);
  return lenses;
}

/** The view an installed plugin registered for a slot and gestalt, running with that plugin's access. */
function useSlots(repo: Repo, plugins: PluginEntry[]): Host['slot'] {
  const views = useMemo(() => {
    const m = new Map<string, ComponentType<SlotProps>>();
    for (const p of plugins) {
      for (const s of p.manifest.slots ?? []) {
        const key = `${s.slot}|${s.gestalt}`;
        if (m.has(key)) continue;
        const View = entryComponent<SlotProps>(p, s.entry);
        const scoped = scopedRepo(repo, p.manifest.id, p.manifest.access as { read?: Scope; write?: Scope });
        const Slotted = (props: SlotProps) => (
          <RepoProvider repo={scoped}>
            <ErrorBoundary name={`${p.manifest.id} ${s.slot}`}><Suspense fallback={null}><View {...props} /></Suspense></ErrorBoundary>
          </RepoProvider>
        );
        m.set(key, Slotted);
      }
    }
    return m;
  }, [repo, plugins]);
  return useCallback((name: string, gestalt: string) => views.get(`${name}|${gestalt}`), [views]);
}
