import { useEffect, useState } from 'react';
import { Bug, Check } from 'lucide-react';
import { debugLog, onDebugLog } from '@gestalts/client';

/**
 * Copies the debug log (see doc/debugging.md) to the clipboard, or downloads it where the clipboard isn't
 * available. Turns red after an error, amber while something takes long.
 */
export function DebugLogButton() {
  const [summary, setSummary] = useState(debugLog.summary);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    // the open-span count changes without an event, so poll lightly too
    const update = () => setSummary(debugLog.summary());
    const off = onDebugLog(update);
    const timer = setInterval(update, 2000);
    return () => { off(); clearInterval(timer); };
  }, []);

  const copy = async () => {
    const text = JSON.stringify(debugLog.snapshot(), null, 1);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      a.download = `gestalts-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const color = summary.errors ? 'text-error' : summary.open && summary.warnings ? 'text-warning' : '';
  const title = `Copy debug log (${summary.open} running, ${summary.warnings} warnings, ${summary.errors} errors)`;
  return (
    <button type="button" className={`btn btn-sm btn-ghost btn-square ${color}`} title={title} aria-label={title} onClick={() => void copy()}>
      {copied ? <Check className="size-4" /> : <Bug className="size-4" />}
    </button>
  );
}
