import { useState } from 'react';
import { Blocks, MonitorSmartphone } from 'lucide-react';
import { registry } from 'virtual:gestalts-plugins';
import { RepoProvider, useConnector, type YmlsIn } from '@gestalts/client';
import { inTauri } from '@gestalts/client/tauri';
import { PluginSettings, ViewTabs, usePluginRepo, type PluginEntry } from '@gestalts/host';
import css from './app.css?inline';
import { Pairing } from './Pairing';

/**
 * The gestalter on a phone: the notes are the app's (`gestalts_device`), synced with the desktop it paired with. In a
 * plain browser (developing the page), they stay in the browser.
 */
const WHERE: YmlsIn = inTauri() ? { native: 'tauri' } : { dir: 'gestalter-phone' };

export function App() {
  const { repo, installed, decks, error } = usePluginRepo(WHERE, registry);
  if (error) return <Failure message={`Could not open your notes: ${error}`} />;
  if (!repo) return <div className="flex h-dvh items-center justify-center"><span className="loading loading-spinner" /></div>;
  return (
    <RepoProvider repo={repo}>
      <ViewTabs registry={registry} css={css} title="gestalter" end={<>
        {registry.distribution.install_ui && <PluginsMenu mounted={installed} decks={decks} />}
        {WHERE.native && <SyncMenu />}
      </>} />
    </RepoProvider>
  );
}

function PluginsMenu({ mounted, decks }: { mounted: PluginEntry[]; decks: string[] }) {
  return (
    <details className="dropdown dropdown-end">
      <summary className="btn btn-sm btn-ghost btn-square" title="Plugins"><Blocks className="size-4" /></summary>
      <div className="dropdown-content z-50 mt-2 max-w-[calc(100vw-2rem)] rounded-box border border-base-300 bg-base-100 p-3 shadow">
        <PluginSettings registry={registry} mounted={mounted} decks={decks} />
      </div>
    </details>
  );
}

function SyncMenu() {
  const { state, error, node } = useConnector();
  const [open, setOpen] = useState(false);
  const tone = state === 'error' ? 'text-error' : node ? '' : 'text-base-content/50';
  return (
    <details className="dropdown dropdown-end" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className={`btn btn-sm btn-ghost btn-square ${tone}`} title={state === 'error' ? error : node ? `Syncing with ${node.name}` : 'Pair with a computer'}>
        {state === 'syncing' ? <span className="loading loading-spinner loading-xs" /> : <MonitorSmartphone className="size-4" />}
      </summary>
      <div className="dropdown-content z-50 mt-2 rounded-box border border-base-300 bg-base-100 p-3 shadow">
        {open && <Pairing />}
      </div>
    </details>
  );
}

function Failure({ message }: { message: string }) {
  return (
    <div className="flex h-dvh items-center justify-center p-4">
      <div role="alert" className="alert alert-error max-w-lg">{message}</div>
    </div>
  );
}
