import { useEffect, useState } from 'react';
import { useConnector } from '@gestalts/client';
import { desktop, type DesktopStatus, type PairingOffer } from './desktop';

const STATE: Record<string, string> = { stopped: 'stopped', starting: 'starting…', ready: 'ready', running: 'running', error: 'error' };

/** The desktop app's settings: the folder, the plugins' workers, start on login. Refreshed while shown. */
export function DesktopSettings() {
  const connection = useConnector();
  const [status, setStatus] = useState<DesktopStatus>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    const poll = () => desktop.status().then((s) => { if (live) setStatus(s); }, () => undefined);
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const act = (f: () => Promise<DesktopStatus | void>) => {
    setError(undefined);
    f().then((s) => { if (s) setStatus(s); }, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  if (connection.state === 'error') {
    return <p className="w-72 text-sm text-error">{connection.error} Start it again; this page picks up where it was.</p>;
  }
  if (!status) return <span className="loading loading-spinner loading-sm" />;
  return (
    <div className="flex w-80 flex-col gap-3 text-sm">
      <section className="flex flex-col gap-1">
        <h3 className="font-semibold">Folder</h3>
        <code className="block truncate text-xs" title={status.folder?.path}>{status.folder?.path ?? 'none'}</code>
        <div className="flex gap-2">
          <button type="button" className="btn btn-sm" onClick={() => act(desktop.chooseFolder)}>Choose another folder…</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => act(desktop.reveal)}>Show</button>
        </div>
        <p className="text-xs text-base-content/60">Choosing another folder reloads the gestalter with its notes.</p>
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="font-semibold">Plugins</h3>
        <p className="text-xs text-base-content/60">
          {status.uv.state === 'locating' && 'Looking for uv…'}
          {status.uv.state === 'downloading' && 'Downloading uv, which runs the plugins…'}
          {status.uv.state === 'ready' && `uv ${status.uv.version}`}
          {status.uv.state === 'failed' && <span className="text-error">uv: {status.uv.error}</span>}
        </p>
        {status.plugins.length === 0 && <p>No plugins with workers.</p>}
        {status.plugins.map((p) => (
          <div key={p.id}>
            {p.id} {p.version} · {STATE[p.state] ?? p.state}
            {p.error && <p className="text-xs text-error">{p.error}</p>}
          </div>
        ))}
      </section>

      {status.lan && <Devices status={status} onError={setError} />}

      {status.clients.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="font-semibold">Other web apps</h3>
          {status.clients.map((c) => <div key={c.origin} className="truncate text-xs">{c.origin} · {c.seconds_ago} s ago</div>)}
        </section>
      )}

      <div className="flex items-center gap-2 border-t border-base-300 pt-2">
        {status.autostart !== null && (
          <label className="label flex-1 cursor-pointer gap-2">
            <input type="checkbox" className="checkbox checkbox-sm" checked={status.autostart}
              onChange={(e) => act(() => desktop.setAutostart(e.target.checked))} />
            Start on login
          </label>
        )}
        <button type="button" className="btn btn-sm btn-ghost ml-auto" onClick={() => act(desktop.quit)}>Quit desktop app</button>
      </div>
      {error && <p className="text-xs text-error">{error}</p>}
      <p className="text-xs text-base-content/50">v{status.version} · {status.address}</p>
    </div>
  );
}

/** Devices on the home network: pairing one by its QR code, and the ones paired. */
function Devices({ status, onError }: { status: DesktopStatus; onError: (e: string) => void }) {
  const lan = status.lan!;
  const [offer, setOffer] = useState<PairingOffer & { until: number }>();
  const [now, setNow] = useState(() => Date.now());
  const paired = status.devices.length;
  const [pairedBefore, setPairedBefore] = useState(paired);
  const fail = (e: unknown) => onError(e instanceof Error ? e.message : String(e));

  useEffect(() => {
    if (!offer) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [offer]);
  // used (a device more), cancelled or expired: the code is gone
  const shown = offer && paired <= pairedBefore && now < offer.until && lan.pairing_open ? offer : undefined;

  const start = () => {
    setPairedBefore(paired);
    desktop.startPairing().then((o) => { setNow(Date.now()); setOffer({ ...o, until: Date.now() + o.expires_in * 1000 }); }, fail);
  };
  const cancel = () => { setOffer(undefined); desktop.cancelPairing().catch(fail); };
  const left = shown ? Math.max(0, Math.round((shown.until - now) / 1000)) : 0;

  return (
    <section className="flex flex-col gap-1">
      <h3 className="font-semibold">Devices</h3>
      {status.devices.map((d) => (
        <div key={d.id} className="flex items-center gap-2">
          <span className="flex-1 truncate">{d.name}</span>
          <span className="text-xs text-base-content/60">{d.last_seen ? `seen ${ago(d.last_seen)}` : 'never seen'}</span>
          <button type="button" className="btn btn-xs btn-ghost" onClick={() => desktop.forgetDevice(d.id).catch(fail)}>Forget</button>
        </div>
      ))}
      {shown ? (
        <div className="flex flex-col items-center gap-1">
          <img className="h-48 w-48 bg-white" alt="Pairing code" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(shown.svg)}`} />
          <p className="text-xs text-base-content/60">
            Scan this with the gestalter on your phone, on the same network. Valid for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}.
          </p>
          <button type="button" className="btn btn-sm btn-ghost" onClick={cancel}>Cancel</button>
        </div>
      ) : (
        <button type="button" className="btn btn-sm self-start" onClick={start}>Pair a device…</button>
      )}
      <p className="text-xs text-base-content/60">
        {lan.listening
          ? `Paired devices reach this computer at ${lan.addresses.join(', ') || `port ${lan.port}`}, encrypted.`
          : 'Not on the network: nothing is paired.'}
      </p>
    </section>
  );
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 90) return 'just now';
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
