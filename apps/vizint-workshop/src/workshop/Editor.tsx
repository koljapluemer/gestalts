import { useEffect, useRef, useState } from 'react';
import { Hammer, Paperclip, Trash2, X } from 'lucide-react';
import type { Repo } from '@gestalts/client';
import { available, build } from './agent';
import { fromBase64, saveViz, storeBlob, toBase64, type Viz } from './viz';

type Line = { kind: 'text' | 'tool' | 'error' | 'ok' | 'fail'; text: string; detail?: string };
type Draft = Pick<Viz, 'title' | 'intro' | 'spec' | 'outro'>;

const draftOf = (v: Viz): Draft => ({ title: v.title, intro: v.intro, spec: v.spec, outro: v.outro });
const SAVE_AFTER_MS = 600;

/** One viz's texts and files, and building it from its spec. Edits are saved as you type. */
export function Editor({ repo, viz, onDelete }: { repo: Repo; viz: Viz; onDelete: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(viz));
  const latest = useRef(viz);
  const pending = useRef<Draft | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState<string>();
  const abort = useRef<AbortController | null>(null);

  useEffect(() => { latest.current = viz; }, [viz]);
  useEffect(() => { void available(repo).then((a) => setUnavailable(a === true ? undefined : a)); }, [repo, busy]);

  const flush = async () => {
    clearTimeout(timer.current);
    const d = pending.current;
    pending.current = null;
    if (d) await saveViz(repo, { ...latest.current, ...d });
  };
  // what's typed and not saved yet is saved on leaving
  const flushOnLeave = useRef(flush);
  useEffect(() => { flushOnLeave.current = flush; });
  useEffect(() => () => { void flushOnLeave.current(); }, []);

  const edit = (k: keyof Draft, value: string) => {
    const next = { ...draft, [k]: value };
    setDraft(next);
    pending.current = next;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_AFTER_MS);
  };

  const say = (l: Line) => setLines((ls) => [...ls, l]);

  const addFiles = async (list: FileList | null) => {
    const added: { file: string; label: string }[] = [];
    for (const f of Array.from(list ?? [])) {
      const label = f.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'file';
      const ext = label.includes('.') ? label.split('.').pop()!.toLowerCase() : 'bin';
      added.push({ file: await storeBlob(repo, new Uint8Array(await f.arrayBuffer()), ext), label });
    }
    const v = latest.current;
    await saveViz(repo, { ...v, files: [...v.files.filter((x) => !added.some((a) => a.label === x.label)), ...added] });
  };
  const removeFile = (label: string) => saveViz(repo, { ...latest.current, files: latest.current.files.filter((f) => f.label !== label) });

  const run = async () => {
    if (busy || !draft.spec.trim()) return;
    await flush();
    setLines([]);
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const v = latest.current;
      const files: Record<string, string> = {};
      for (const f of v.files) files[f.label] = toBase64((await repo.readBlob(f.file)) ?? new Uint8Array());
      const req = { viz: v.id, title: draft.title, spec: draft.spec, source: v.source || undefined, packages: v.packages, files };
      for await (const e of build(repo, req, controller.signal)) {
        if (e.type === 'text') say({ kind: 'text', text: e.text });
        else if (e.type === 'tool') say({ kind: 'tool', text: `${e.name} ${e.summary}` });
        else if (e.type === 'error') say({ kind: 'error', text: e.message });
        else if (e.type === 'result') {
          const now = latest.current;
          const next: Viz = { ...now, source: e.source ?? now.source, packages: e.packages };
          if (e.ok && e.built) {
            next.built = await storeBlob(repo, new TextEncoder().encode(e.built), 'html');
            next.still = e.still ? await storeBlob(repo, fromBase64(e.still), 'png') : undefined;
            next.generator = e.generator;
          }
          await saveViz(repo, next);
          say(e.ok
            ? { kind: 'ok', text: 'Built and checked.', detail: e.check }
            : { kind: 'fail', text: 'The check failed: the source is saved, the page shown is the last one that passed.', detail: e.check });
        }
      }
    } catch (e) {
      say({ kind: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  const field = 'textarea textarea-sm w-full font-mono';
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto bg-base-100 p-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-base-content/60">Title</span>
        <input className="input input-sm w-full" value={draft.title} onChange={(e) => edit('title', e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-base-content/60">Before it (Markdown)</span>
        <textarea className={field} rows={3} value={draft.intro} onChange={(e) => edit('intro', e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-base-content/60">Spec: what the viz shows and does</span>
        <textarea className={field} rows={8} value={draft.spec} onChange={(e) => edit('spec', e.target.value)}
                  placeholder="e.g. Show how a Bézier curve is drawn by de Casteljau's construction; the control points are draggable." />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-base-content/60">After it (Markdown)</span>
        <textarea className={field} rows={3} value={draft.outro} onChange={(e) => edit('outro', e.target.value)} />
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-base-content/60">Files the spec can name</span>
        <ul className="flex flex-wrap gap-1">
          {viz.files.map((f) => (
            <li key={f.label} className="badge badge-outline gap-1">
              {f.label}
              <button type="button" title={`Remove ${f.label}`} aria-label={`Remove ${f.label}`} onClick={() => void removeFile(f.label)}><X className="size-3" /></button>
            </li>
          ))}
        </ul>
        <label className="btn btn-xs btn-ghost self-start"><Paperclip className="size-3" />Add files
          <input type="file" multiple className="hidden" onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
        </label>
      </div>
      {viz.packages.length > 0 && <p className="text-xs text-base-content/60">Packages: {viz.packages.join(', ')}</p>}

      <div className="flex items-center gap-2">
        {busy
          ? <button type="button" className="btn btn-sm" onClick={() => abort.current?.abort()}>Stop</button>
          : <button type="button" className="btn btn-sm btn-primary" disabled={!draft.spec.trim() || Boolean(unavailable)} onClick={() => void run()}><Hammer className="size-4" />{viz.source ? 'Rebuild from the spec' : 'Build'}</button>}
        {busy && <span className="loading loading-dots loading-sm" />}
        <span className="flex-1" />
        <button type="button" className="btn btn-sm btn-ghost" title="Delete this viz" aria-label="Delete this viz"
                onClick={() => { if (confirm(`Delete “${viz.title}”?`)) onDelete(); }}><Trash2 className="size-4" /></button>
      </div>
      {unavailable && <p role="status" className="text-xs text-warning">{unavailable}</p>}
      {viz.generator && !busy && !lines.length && <p className="text-xs text-base-content/50">Last built by {viz.generator}.</p>}

      {lines.length > 0 && (
        <div className="space-y-1 border-t border-base-300 pt-2">
          {lines.map((l, i) => (
            <div key={i} className={l.kind === 'tool' ? 'font-mono text-xs text-base-content/50' : l.kind === 'error' || l.kind === 'fail' ? 'text-error' : l.kind === 'ok' ? 'text-success' : 'whitespace-pre-wrap'}>
              {l.text}
              {l.detail && <details><summary className="cursor-pointer text-xs text-base-content/60">The check</summary><pre className="overflow-x-auto text-xs text-base-content">{l.detail}</pre></details>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
