import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import type { ServiceClient } from '@gestalts/sdk';
import { ollamaPull, ollamaPullStatus, pullRunning, type Pull } from './ollama';

const POLL_MS = 1000;

/** Downloads a missing Ollama model through `ollama@1`, with its progress; `onInstalled` once it's there. */
export function ModelDownload({ llm, model, onInstalled }: { llm: ServiceClient | undefined; model: string; onInstalled: () => void }) {
  const [pull, setPull] = useState<Pull | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(onInstalled);
  // a perspective gets a new client each render: the effects follow its address
  const client = useRef(llm);
  useEffect(() => { done.current = onInstalled; client.current = llm; });
  const address = llm ? `${llm.baseUrl}/${llm.id}` : null;

  // a download already under way (from another tab, or before a reload) shows its progress
  useEffect(() => {
    let stop = false;
    void ollamaPullStatus(client.current, model).then((p) => { if (!stop) setPull(p); }, () => {});
    return () => { stop = true; };
  }, [address, model]);

  const running = pullRunning(pull);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      ollamaPullStatus(client.current, model).then((p) => {
        setPull(p);
        if (p?.status === 'success') done.current();
      }, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [running, address, model]);

  async function start() {
    setError(null);
    try { setPull(await ollamaPull(llm, model)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  const failed = error ?? pull?.error;
  if (running && pull) {
    const pct = pull.total ? Math.round((100 * pull.completed) / pull.total) : null;
    return (
      <span className="inline-flex items-center gap-2">
        <span>Downloading {model}: {pull.status}</span>
        {pct !== null && <progress className="progress w-32" value={pct} max={100} />}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" className="btn btn-xs" onClick={() => void start()} disabled={!llm}><Download className="size-3" />Download {model}</button>
      {failed && <span className="text-error">{failed}</span>}
    </span>
  );
}
