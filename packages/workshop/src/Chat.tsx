import { useEffect, useRef, useState } from 'react';
import type { Repo } from '@gestalts/client';
import type { ViewError } from '@gestalts/view';
import type { AgentBackend, Diagnostic } from './agents/types';
import { applyFiles, filesOf, loadMembers, saveDraft, type Draft } from './draft';

type Line = { who: 'you' | 'agent' | 'tool' | 'error'; text: string };

const sessionKey = (view: string) => `workshop:session:${view}`;
function savedSession(view: string) { try { return localStorage.getItem(sessionKey(view)) ?? undefined; } catch { return undefined; } }

/**
 * One conversation about one draft. Each turn sends the draft as files, and saves what comes back. What couldn't be
 * saved goes with the next message, as the preview's errors do. `runtime` is recorded on the draft with each save.
 */
export function Chat({ repo, draft, backend, runtime, errors, onTurnDone }: {
  repo: Repo; draft: Draft; backend: AgentBackend; runtime?: string; errors: ViewError[]; onTurnDone: () => void;
}) {
  const [refused, setRefused] = useState<Diagnostic[]>([]);
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
    let current = draft;
    try {
      let members = await loadMembers(repo, current);
      const gestalts = (await repo.gestalts()).map((g) => `${g.name}@${g.version}`).filter((g) => !g.startsWith(`${current.package}/`));
      const diagnostics: Diagnostic[] = [...refused, ...errors];
      setRefused([]);
      for await (const e of backend.turn({ view: draft.id, session: savedSession(draft.id), message, files: filesOf(current, members), gestalts, diagnostics }, controller.signal)) {
        if (e.type === 'text') say({ who: 'agent', text: e.text });
        else if (e.type === 'tool') say({ who: 'tool', text: `${e.name} ${e.summary}` });
        else if (e.type === 'error') say({ who: 'error', text: e.message });
        else if (e.type === 'files') {
          const saved = await saveDraft(repo, applyFiles(current, members, e.files), runtime);
          current = saved.draft;
          members = await loadMembers(repo, current);
          if (saved.problems.length) {
            const at = new Date().toISOString();
            saved.problems.forEach((p) => say({ who: 'error', text: `not saved: ${p}` }));
            setRefused(saved.problems.map((p) => ({ kind: 'save', message: p, at })));
          }
        } else if (e.session) {
          try { localStorage.setItem(sessionKey(draft.id), e.session); } catch { /* the next turn starts afresh */ }
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
      {errors.length + refused.length > 0 && <p role="status" className="px-3 text-xs text-error">{errors.length + refused.length} error(s) from the preview and saving go with your next message.</p>}
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
