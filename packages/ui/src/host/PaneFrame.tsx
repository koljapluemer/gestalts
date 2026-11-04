import { Suspense, useCallback, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { HostProvider, RepoProvider, type Host, type Query, type SlotProps } from '@gestalts/sdk';
import { Modal, NewNote, NotePicker, UniversalEditor } from '@gestalts/kit';
import type { Repo } from '@gestalts/client';
import { ErrorBoundary } from '../debug';
import { useOverlay } from './overlay';
import { entryComponent, type PluginEntry, type Scope } from './registry';
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
 * Where a plugin's pane runs: the host's capabilities (its note editor and new-note form over the pane, a note
 * picker, slots) and the repo scoped to the plugin's `access`. The editor and form are the host's, so they get the
 * host's repo.
 */
export function PaneFrame({ repo, plugins, plugin, navigate, setTitle, children }: Props) {
  const [overlay, overlays] = useOverlay();
  const [picking, setPicking] = useState<{ query: Query; title?: string; resolve: (key: string | null) => void } | null>(null);
  const slot = useSlots(repo, plugins);
  const host = useMemo<Host>(() => ({
    openNote: (key) => overlays.open({ kind: 'note', key }),
    createNote: (draft) => overlays.open({ kind: 'new', ...draft }),
    pickNote: (query, title) => new Promise((resolve) => setPicking({ query, title, resolve })),
    navigate,
    setTitle,
    slot,
  }), [overlays, navigate, setTitle, slot]);
  const scoped = useMemo(() => scopedRepo(repo, plugin.manifest.id, plugin.manifest.access), [repo, plugin]);
  const pick = (key: string | null) => { picking?.resolve(key); setPicking(null); };
  return (
    <HostProvider host={host}>
      <RepoProvider repo={scoped}>
        <Suspense fallback={<div className="flex justify-center p-8"><span className="loading loading-spinner" /></div>}>{children}</Suspense>
      </RepoProvider>
      {overlay && (
        <Modal onClose={overlays.close}>
          {overlay.kind === 'note'
            ? <UniversalEditor key={overlay.key} open={[overlay.key]} onClose={overlays.close} onOpen={(key) => overlays.open({ kind: 'note', key })} />
            : <NewNote key={JSON.stringify(overlay)} title={overlay.title} tags={overlay.tags} onCreated={(key) => overlays.replace({ kind: 'note', key })} onCancel={overlays.close} />}
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
