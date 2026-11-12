import { useEffect, useState } from 'react';
import { Blocks, HardDrive, Sparkles } from 'lucide-react';
import { registry } from 'virtual:gestalts-plugins';
import { RepoProvider, nodeHealth, useConnector, type NodeHealth } from '@gestalts/client';
import { LlmSettings, PluginSettings, ViewTabs, usePluginRepo, type PluginEntry } from '@gestalts/host';
import css from './app.css?inline';
import { DesktopSettings } from './DesktopSettings';
import { NODE, desktop } from './desktop';

/** The gestalter, served by its desktop app: the notes are the folder the app serves, used directly. */
export function App() {
  const [health, setHealth] = useState<NodeHealth | { error: string }>();
  useEffect(() => {
    nodeHealth(NODE).then(setHealth, (e: unknown) => setHealth({ error: e instanceof Error ? e.message : String(e) }));
  }, []);
  if (!health) return <Spinner />;
  if ('error' in health) return <Failure message={`The gestalter desktop app isn't running (${health.error}). Start it, then reload.`} />;
  if (!health.folder) return <ChooseFolder onChosen={(folder) => setHealth({ ...health, folder })} />;
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
        <LlmMenu />
        <DesktopMenu />
      </>} />
    </RepoProvider>
  );
}

/** The first start: the notes live in a folder the user picks. */
function ChooseFolder({ onChosen }: { onChosen: (folder: NonNullable<NodeHealth['folder']>) => void }) {
  const [error, setError] = useState<string>();
  const choose = () => {
    setError(undefined);
    desktop.chooseFolder().then((s) => { if (s.folder) onChosen(s.folder); }, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <div className="flex h-dvh items-center justify-center p-4">
      <div className="flex max-w-md flex-col gap-3">
        <h1 className="text-xl font-semibold">Welcome to the gestalter</h1>
        <p>Your notes live in a folder on this computer, as plain files you can back up and sync like any others. Choose
          an empty folder to start, or one you've used with this version before.</p>
        <button type="button" className="btn btn-primary self-start" onClick={choose}>Choose folder…</button>
        {error && <p className="text-sm text-error">{error}</p>}
      </div>
    </div>
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

function LlmMenu() {
  const [open, setOpen] = useState(false);
  return (
    <details className="dropdown dropdown-end" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="btn btn-sm btn-ghost btn-square" title="LLM providers"><Sparkles className="size-4" /></summary>
      <div className="dropdown-content z-50 mt-2 max-h-[80dvh] overflow-y-auto rounded-box border border-base-300 bg-base-100 p-3 shadow">
        {open && <LlmSettings />}
      </div>
    </details>
  );
}

function DesktopMenu() {
  const { state, error } = useConnector();
  const [open, setOpen] = useState(false);
  return (
    <details className="dropdown dropdown-end" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className={`btn btn-sm btn-ghost btn-square ${state === 'error' ? 'text-error' : ''}`} title={state === 'error' ? error : 'Desktop app'}>
        <HardDrive className="size-4" />
      </summary>
      <div className="dropdown-content z-50 mt-2 rounded-box border border-base-300 bg-base-100 p-3 shadow">
        {open && <DesktopSettings />}
      </div>
    </details>
  );
}

function Spinner() {
  return <div className="flex h-dvh items-center justify-center"><span className="loading loading-spinner" /></div>;
}

function Failure({ message }: { message: string }) {
  return (
    <div className="flex h-dvh items-center justify-center p-4">
      <div role="alert" className="alert alert-error max-w-lg">{message}</div>
    </div>
  );
}
