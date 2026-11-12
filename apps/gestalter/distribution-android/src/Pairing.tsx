import { useState } from 'react';
import { useConnector, useHostRepo } from '@gestalts/client';
import { forget, pair } from '@gestalts/client/tauri';
import { Format, cancel, requestPermissions, scan } from '@tauri-apps/plugin-barcode-scanner';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Pairing with the desktop (its settings show the code under "Devices"), and how syncing with it goes. */
export function Pairing() {
  const status = useConnector();
  return (
    <div className="flex w-[min(20rem,calc(100vw-2rem))] flex-col gap-2">
      {status.node ? <Paired /> : <Unpaired />}
    </div>
  );
}

function Unpaired() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (get: () => Promise<string>) => {
    setBusy(true);
    setError(undefined);
    try {
      await pair(await get());
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const scanCode = async () => {
    if ((await requestPermissions()) !== 'granted') throw new Error('Scanning needs the camera: allow it in the app\'s settings, or paste the code.');
    try {
      return (await scan({ formats: [Format.QRCode], windowed: false })).content;
    } finally {
      void cancel().catch(() => undefined);
    }
  };
  return (
    <>
      <p className="text-sm text-base-content/70">
        Your notes are on this phone. To sync them with your computer, open the gestalter there, then its settings, then
        "Devices", and scan the code it shows. Both need to be on the same Wi-Fi.
      </p>
      <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void run(scanCode)}>
        {busy ? <span className="loading loading-spinner loading-xs" /> : 'Scan pairing code'}
      </button>
      <details className="text-sm">
        <summary className="cursor-pointer text-base-content/60">Paste the code instead</summary>
        <div className="mt-2 flex gap-2">
          <input className="input input-sm min-w-0 flex-1" value={code} onChange={(e) => setCode(e.target.value)} placeholder="gestalts-pair:…" aria-label="Pairing code" />
          <button type="button" className="btn btn-sm" disabled={busy || !code.trim()} onClick={() => void run(async () => code.trim())}>Pair</button>
        </div>
      </details>
      {error && <p className="text-sm text-error">{error}</p>}
    </>
  );
}

function Paired() {
  const repo = useHostRepo();
  const status = useConnector();
  const [error, setError] = useState<string>();
  const report = status.lastReport;
  return (
    <>
      <p className="text-sm">Syncing with <strong>{status.node?.name}</strong> while this app is open and both are on the same Wi-Fi.</p>
      <p className="text-xs text-base-content/60">
        {status.state === 'syncing' && 'Syncing…'}
        {status.state === 'ok' && (status.lastSync
          ? `Last synced ${status.lastSync.toLocaleString()}${report ? ` · ${report.pulled.length} in, ${report.pushed.length} out` : ''}`
          : 'Not synced yet.')}
        {status.state === 'error' && <span className="text-error">{status.error}</span>}
        {status.state === 'error' && status.lastSync && <span className="block">Last synced {status.lastSync.toLocaleString()}</span>}
        {status.folder && status.state !== 'error' && <code className="block truncate" title={status.folder}>{status.folder}</code>}
      </p>
      <div className="flex gap-2">
        <button type="button" className="btn btn-sm flex-1" disabled={status.state === 'syncing'} onClick={() => void repo.sync()}>Sync now</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => {
          if (!confirm(`Stop syncing with ${status.node?.name}? The notes stay on this phone. Remove the phone on the computer too, under "Devices".`)) return;
          forget().catch((e: unknown) => setError(message(e)));
        }}>Forget</button>
      </div>
      {error && <p className="text-sm text-error">{error}</p>}
    </>
  );
}
