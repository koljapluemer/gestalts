import { useState } from 'react';
import { useHostRepo } from '@gestalts/client';
import { useQuery } from '@gestalts/sdk';
import { install, installState, setEnabled, uninstall } from './installs';
import type { PluginEntry, Registry, Scope } from './registry';

function scopeText(s: Scope | undefined): string {
  if (s === 'all') return 'all notes';
  const parts = [...(s?.gestalts ?? []), ...(s?.tags_all?.length ? [`#${s.tags_all.join(' #')}`] : [])];
  return parts.length ? parts.join(', ') : 'nothing';
}

/**
 * The plugins bundled with this app: what each may read and write, and whether it's installed here (a
 * `plugin-install@1` note, so the choice syncs). Changing installs takes a reload, which mounts or unmounts decks.
 */
export function PluginSettings({ registry, mounted }: { registry: Registry; mounted: PluginEntry[] }) {
  const repo = useHostRepo();
  useQuery({ gestalt: 'plugin-install@1' }); // re-render when installs change
  const [removeData, setRemoveData] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = (f: () => Promise<void>) => { setBusy(true); void f().finally(() => setBusy(false)); };
  const changed = registry.plugins.some((p) => (installState(repo, p.manifest.id) === 'installed') !== mounted.includes(p));
  return (
    <div className="flex w-96 max-w-[90vw] flex-col gap-2">
      <p className="text-sm text-base-content/70">Plugins bundled with this app. Uninstalling one keeps your copies of its notes unless you remove them too.</p>
      <ul className="flex flex-col gap-2">
        {registry.plugins.map((p) => {
          const state = installState(repo, p.manifest.id);
          return (
            <li key={p.manifest.id} className="rounded-box border border-base-300 p-2 text-sm">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{p.manifest.title ?? p.manifest.id} <span className="font-normal text-base-content/50">{p.manifest.version}</span></p>
                  {p.manifest.description && <p className="text-xs text-base-content/70">{p.manifest.description}</p>}
                  <p className="text-xs text-base-content/60">Reads {scopeText(p.manifest.access?.read ?? 'all')}; writes {scopeText(p.manifest.access?.write)}.</p>
                </div>
                {state === 'uninstalled'
                  ? <button type="button" className="btn btn-xs btn-primary" disabled={busy} onClick={() => run(() => install(repo, p))}>Install</button>
                  : (
                    <div className="flex flex-col items-end gap-1">
                      <label className="label text-xs">
                        <input type="checkbox" className="toggle toggle-xs" checked={state === 'installed'} disabled={busy}
                               onChange={(e) => run(() => setEnabled(repo, p, e.target.checked))} />
                        on
                      </label>
                      <button type="button" className="btn btn-xs btn-ghost" disabled={busy} onClick={() => {
                        if (confirm(`Uninstall ${p.manifest.title ?? p.manifest.id}?${removeData ? '\nYour copies of its notes are deleted too.' : ''}`)) run(() => uninstall(repo, p, removeData));
                      }}>Uninstall</button>
                    </div>
                  )}
              </div>
            </li>
          );
        })}
      </ul>
      <label className="label text-xs">
        <input type="checkbox" className="checkbox checkbox-xs" checked={removeData} onChange={(e) => setRemoveData(e.target.checked)} />
        When uninstalling, also delete my copies of the plugin's deck notes
      </label>
      {changed && <button type="button" className="btn btn-sm" onClick={() => location.reload()}>Reload to apply</button>}
    </div>
  );
}
