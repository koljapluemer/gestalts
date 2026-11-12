import { useEffect, useState, type ReactNode } from 'react';
import { Blocks, HardDrive } from 'lucide-react';
import { registry } from 'virtual:gestalts-plugins';
import { RepoProvider, nodeHealth, useConnector, type NodeHealth } from '@gestalts/client';
import { PluginSettings, ViewTabs, usePluginRepo, type PluginEntry } from '@gestalts/host';
import css from './app.css?inline';

/** The gestalts-node on this computer, whose folder holds the notes. */
const NODE = import.meta.env.VITE_GESTALTS_NODE ?? 'http://127.0.0.1:7717';

/** The gestalter, a website on the gestalts-node on this computer: the notes are its folder, used directly. */
export function App() {
  const [health, setHealth] = useState<NodeHealth | { error: string }>();
  useEffect(() => {
    nodeHealth(NODE).then(setHealth, (e: unknown) => setHealth({ error: e instanceof Error ? e.message : String(e) }));
  }, []);
  if (!health) return <Spinner />;
  if ('error' in health) return <Failure message={<>gestalts-node isn't running on this computer ({health.error}). Start it, then reload. Your browser may ask whether this page may use apps on this device: allow it.</>} />;
  if (!health.folder) return <Failure message={<>gestalts-node has no folder yet. Choose one in its <a className="link" href={`${NODE}/`}>settings</a>, then reload.</>} />;
  return <Workspace />;
}

function Workspace() {
  const { repo, installed, decks, error } = usePluginRepo({ node: NODE }, registry);
  if (error) return <Failure message={`Could not open your notes: ${error}`} />;
  if (!repo) return <Spinner />;
  return (
    <RepoProvider repo={repo}>
      <ViewTabs registry={registry} css={css} title="gestalter" end={<>
        {registry.distribution.install_ui && <PluginsMenu mounted={installed} decks={decks} />}
        <NodeLink />
      </>} />
    </RepoProvider>
  );
}

function PluginsMenu({ mounted, decks }: { mounted: PluginEntry[]; decks: string[] }) {
  return (
    <details className="dropdown dropdown-end">
      <summary className="btn btn-sm btn-ghost btn-square" title="Plugins"><Blocks className="size-4" /></summary>
      <div className="dropdown-content z-50 mt-2 rounded-box border border-base-300 bg-base-100 p-3 shadow">
        <PluginSettings registry={registry} mounted={mounted} decks={decks} />
      </div>
    </details>
  );
}

/** The node's own settings (folder, devices, LLM providers, workers), on its page; red while it can't be reached. */
function NodeLink() {
  const { state, error } = useConnector();
  return (
    <a className={`btn btn-sm btn-ghost btn-square ${state === 'error' ? 'text-error' : ''}`} href={`${NODE}/`} target="_blank" rel="noreferrer"
       title={state === 'error' ? error : 'gestalts-node settings'}>
      <HardDrive className="size-4" />
    </a>
  );
}

function Spinner() {
  return <div className="flex h-dvh items-center justify-center"><span className="loading loading-spinner" /></div>;
}

function Failure({ message }: { message: ReactNode }) {
  return (
    <div className="flex h-dvh items-center justify-center p-4">
      <div role="alert" className="alert alert-error max-w-lg">{message}</div>
    </div>
  );
}
