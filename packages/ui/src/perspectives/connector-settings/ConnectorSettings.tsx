import { useState } from 'react';
import { useConnector, useHostRepo } from '@gestalts/client';
import { definePerspective } from '@gestalts/sdk';
import { Conflicts } from '@gestalts/kit';

const DEFAULT_URL = 'http://127.0.0.1:7717';

/** Connect to a running gestalts-connector, which makes a folder on disk the source of truth. */
export const ConnectorSettings = definePerspective<Record<string, never>, { onOpen?: (key: string) => void }>({
  id: 'connector-settings',
  title: 'Connector',
  data: {},
  Component: ({ onOpen }) => {
    const repo = useHostRepo();
    const status = useConnector();
    const [url, setUrl] = useState(status.url ?? DEFAULT_URL);
    return (
      <div className="flex w-72 flex-col gap-2">
        <p className="text-sm text-base-content/70">
          Sync with a folder on this computer through the Gestalts Connector app. Without it, everything stays in this browser.
        </p>
        <input className="input input-sm w-full" value={url} onChange={(e) => setUrl(e.target.value)} disabled={!!status.url} aria-label="Connector URL" />
        {status.url ? (
          <div className="flex gap-2">
            <button type="button" className="btn btn-sm flex-1" disabled={status.state === 'syncing'} onClick={() => void repo.sync()}>Sync now</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => repo.disconnect()}>Disconnect</button>
          </div>
        ) : (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void repo.connect(url)}>Connect</button>
        )}
        <p className="text-xs text-base-content/60">
          {status.state === 'off' && 'Not connected.'}
          {status.state === 'syncing' && 'Syncing…'}
          {status.state === 'ok' && `Synced ${status.lastSync?.toLocaleTimeString() ?? ''}${status.lastReport ? ` · ${status.lastReport.pulled.length} in, ${status.lastReport.pushed.length} out` : ''}`}
          {status.folder && status.state !== 'error' && <code className="block truncate" title={status.folder}>{status.folder}</code>}
          {status.state === 'error' && <span className="text-error">{status.error}</span>}
        </p>
        <Conflicts onOpen={onOpen} />
      </div>
    );
  },
});

/** For badges: off, ok, syncing or error. */
export function useConnectorState() {
  return useConnector().state;
}
