import { useState } from 'react';
import { useHostQuery, useHostRepo } from '@gestalts/client';
import { deckEnabled, install, installState, setDeckEnabled, setEnabled, uninstall, wantedDecks } from './installs';
import type { PluginEntry, Registry } from './registry';

const scopeText = (gestalts: string[] | undefined) => (gestalts?.length ? gestalts.join(', ') : 'nothing');

/**
 * The plugins bundled with this app: what each may read and write, and whether it's installed here (a
 * `plugin-install@1` yml, so the choice syncs), and which of its decks are on. Changing installs or decks takes a
 * reload, which mounts or unmounts decks. `mounted`: the plugins installed when the repo opened; `decks`: the deck
 * sources mounted then.
 */
export function PluginSettings({ registry, mounted, decks }: { registry: Registry; mounted: PluginEntry[]; decks: string[] }) {
  const repo = useHostRepo();
  useHostQuery({ gestalt: 'plugin-install@1', limit: 500 }); // re-render when installs change
  const [busy, setBusy] = useState(false);
  const run = (f: () => Promise<unknown>) => { setBusy(true); void f().finally(() => setBusy(false)); };
  const changed = registry.plugins.some((p) => (p.core || installState(repo, p.manifest.id) === 'installed') !== mounted.includes(p))
    || wantedDecks(repo, registry).map((d) => d.source).sort().join() !== [...decks].sort().join();
  return (
    <div className="flex w-96 max-w-[90vw] flex-col gap-2">
      <p className="text-sm text-base-content/70">Plugins bundled with this app. Uninstalling one keeps what you wrote while using it.</p>
      <ul className="flex flex-col gap-2">
        {registry.plugins.map((p) => {
          const state = installState(repo, p.manifest.id);
          return (
            <li key={p.manifest.id} className="rounded-box border border-base-300 p-2 text-sm">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{p.manifest.title} <span className="font-normal text-base-content/50">{p.manifest.version}</span></p>
                  {p.manifest.description && <p className="text-xs text-base-content/70">{p.manifest.description}</p>}
                  <p className="text-xs text-base-content/60">Reads {scopeText(p.manifest.reads)}; writes {scopeText(p.manifest.writes)}.</p>
                  {state !== 'uninstalled' && p.decks.length > 1 && (
                    <div className="mt-1 flex flex-wrap gap-x-3">
                      {p.decks.map((d) => (
                        <label key={d.id} className="label text-xs">
                          <input type="checkbox" className="checkbox checkbox-xs" checked={deckEnabled(repo, p, d.id)} disabled={busy}
                                 onChange={(e) => run(() => setDeckEnabled(repo, p, d.id, e.target.checked))} />
                          {d.title}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                {p.core ? <span className="badge badge-sm">core</span> : state === 'uninstalled'
                  ? <button type="button" className="btn btn-xs btn-primary" disabled={busy} onClick={() => run(() => install(repo, p))}>Install</button>
                  : (
                    <div className="flex flex-col items-end gap-1">
                      <label className="label text-xs">
                        <input type="checkbox" className="toggle toggle-xs" checked={state === 'installed'} disabled={busy}
                               onChange={(e) => run(() => setEnabled(repo, p, e.target.checked))} />
                        on
                      </label>
                      <button type="button" className="btn btn-xs btn-ghost" disabled={busy} onClick={() => {
                        if (confirm(`Uninstall ${p.manifest.title}?`)) run(() => uninstall(repo, p));
                      }}>Uninstall</button>
                    </div>
                  )}
              </div>
            </li>
          );
        })}
      </ul>
      {changed && <button type="button" className="btn btn-sm" onClick={() => location.reload()}>Reload to apply</button>}
    </div>
  );
}
