import { useEffect, useRef, useState } from 'react';
import type { Repo } from '@gestalts/client';
import type { ViewError } from '@gestalts/view';
import { cliBackend } from './agents/cli';
import type { AgentBackend } from './agents/types';
import { applyFiles, filesOf, saveView, type VibeView } from './workshop';

type Line = { who: 'you' | 'agent' | 'tool' | 'error'; text: string };

const sessionKey = (view: string) => `workshop:session:${view}`;
function savedSession(view: string) { try { return localStorage.getItem(sessionKey(view)) ?? undefined; } catch { return undefined; } }

/** One conversation about one view. Each turn sends the view as files, and saves what comes back. */
export function Chat({ repo, view, errors, onTurnDone }: { repo: Repo; view: VibeView; errors: ViewError[]; onTurnDone: () => void }) {
  const [backend] = useState<AgentBackend>(() => cliBackend(repo));
  const [lines, setLines] = useState<Line[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState<string>();
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => { void backend.available().then((a) => setUnavailable(a === true ? undefined : a)); }, [backend, busy]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [lines]);

  const say = (l: Line) => setLines((ls) => [...ls, l]);

  const send = async () => {
    const message = text.trim();
    if (!message || busy) return;
    setText('');
    say({ who: 'you', text: message });
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    let current = view;
    try {
      for await (const e of backend.turn({ view: view.id, session: savedSession(view.id), message, files: filesOf(view), diagnostics: errors }, controller.signal)) {
        if (e.type === 'text') say({ who: 'agent', text: e.text });
        else if (e.type === 'tool') say({ who: 'tool', text: `${e.name} ${e.summary}` });
        else if (e.type === 'error') say({ who: 'error', text: e.message });
        else if (e.type === 'files') {
          current = applyFiles(current, e.files);
          await saveView(repo, current);
        } else if (e.session) {
          try { localStorage.setItem(sessionKey(view.id), e.session); } catch { /* the next turn starts afresh */ }
        }
      }
      onTurnDone();
    } catch (e) {
      say({ who: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-base-100">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-sm">
        {lines.map((l, i) => (
          <p key={i} className={`whitespace-pre-wrap ${l.who === 'you' ? 'font-semibold' : l.who === 'tool' ? 'font-mono text-xs text-base-content/50' : l.who === 'error' ? 'text-error' : ''}`}>{l.text}</p>
        ))}
        {busy && <span className="loading loading-dots loading-sm" />}
        <div ref={end} />
      </div>
      {unavailable && <p role="status" className="px-3 text-xs text-warning">{unavailable}</p>}
      {errors.length > 0 && <p role="status" className="px-3 text-xs text-error">{errors.length} error(s) from the preview go with your next message.</p>}
      <div className="flex gap-2 border-t border-base-300 p-2">
        <textarea className="textarea textarea-sm min-w-0 flex-1" rows={2} placeholder="What should it do?" value={text} onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        {busy
          ? <button type="button" className="btn btn-sm" onClick={() => abort.current?.abort()}>Stop</button>
          : <button type="button" className="btn btn-sm btn-primary" disabled={!text.trim() || Boolean(unavailable)} onClick={() => void send()}>Send</button>}
      </div>
    </div>
  );
}
