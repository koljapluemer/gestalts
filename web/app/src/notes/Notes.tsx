import { Blocks, Settings } from 'lucide-react';
import { registry } from 'virtual:gestalts-plugins/home';
import { ConnectorSettings, PluginSettings, ViewTabs, type PluginEntry } from '@gestalts/host';
import css from '../app.css?inline';
import { WithHome } from '../home';
import { HOME_NODE } from '../nodes';
import { Areas } from '../router';

/** The gestalter: notes and every installed plugin, in tabs, on the home store. */
export function Notes() {
  return (
    <WithHome>
      {(_, { installed, decks }) => (
        <ViewTabs registry={registry} css={css} title="gestalter" end={<>
          {registry.distribution.install_ui && <PluginsMenu mounted={installed} decks={decks} />}
          <SyncMenu />
          <Areas end />
        </>} />
      )}
    </WithHome>
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

/** Syncing the home store with a node (the desktop app's folder), if the user wants that. */
export function SyncMenu() {
  return (
    <details className="dropdown dropdown-end">
      <summary className="btn btn-sm btn-ghost btn-square" title="Sync settings"><Settings className="size-4" /></summary>
      <div className="dropdown-content z-50 mt-2 rounded-box border border-base-300 bg-base-100 p-3 shadow"><ConnectorSettings defaultUrl={HOME_NODE} /></div>
    </details>
  );
}
