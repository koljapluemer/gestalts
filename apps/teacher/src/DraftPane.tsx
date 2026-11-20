import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, Link2Off, Send, Trash2 } from 'lucide-react';
import { registry } from 'virtual:gestalts-plugins';
import { RepoProvider, useConnector, useHostQuery, useOpenRepo, type Repo } from '@gestalts/client';
import { closedCsp } from '@gestalts/host';
import type { ViewError } from '@gestalts/view';
import { Chat, Preview, VIEWS, asDraft, createDraft, httpBackend, saveDraft } from '@gestalts/workshop';
import tailwind from '@tailwindcss/browser?raw';
import css from './app.css?inline';
import * as api from './api';

/**
 * One draft: its own folder in this browser, synced with the server's copy, which the server checks. Opening it
 * makes its view if the server has none yet, and records the runtime it is now previewed against.
 */
export function DraftPane({ info, onChanged, onDeleted }: { info: api.DraftInfo; onChanged: () => void; onDeleted: () => void }) {
  const source = useMemo(() => ({ dir: `teacher-draft-${info.id}`, gestalts: registry.gestalts }), [info.id]);
  const { repo, error } = useOpenRepo(source);
  const [ready, setReady] = useState<Repo>();
  const [failed, setFailed] = useState<string>();
  useEffect(() => {
    if (!repo) return;
    let live = true;
    (async () => {
      await repo.connect(api.draftUrl(info.id));
      if (!(await repo.get(info.id))) await createDraft(repo, info.title, registry.runtime.version, { id: info.id, package: info.package });
      if (live) setReady(repo);
    })().catch((e: unknown) => { if (live) setFailed(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [repo, info.id, info.title, info.package]);
  const problem = error ?? failed;
  if (problem) return <div role="alert" className="alert alert-error m-4">This lesson couldn’t open: {problem}</div>;
  if (!ready) return <div className="flex h-full items-center justify-center"><span className="loading loading-spinner" /></div>;
  return <RepoProvider repo={ready}><Workbench repo={ready} info={info} onChanged={onChanged} onDeleted={onDeleted} /></RepoProvider>;
}

function Workbench({ repo, info, onChanged, onDeleted }: { repo: Repo; info: api.DraftInfo; onChanged: () => void; onDeleted: () => void }) {
  const items = useHostQuery({ gestalt: VIEWS, ids: [info.id] });
  const draft = useMemo(() => (items[0] ? asDraft(items[0]) : undefined), [items]);
  const [errors, setErrors] = useState<ViewError[]>([]);
  const onError = useCallback((e: ViewError) => setErrors((es) => [...es, e].slice(-20)), []);
  const backend = useMemo(() => httpBackend(`/api/drafts/${info.id}/agent`, { id: 'teacher-server', label: 'Claude' }), [info.id]);
  const csp = useMemo(() => closedCsp({ scripts: [`${location.origin}/api/npm/`] }), []);
  const runtime = registry.runtime.version;
  // previewed against this runtime now, so that's what it's published for
  useEffect(() => {
    if (draft && draft.runtime !== runtime) void saveDraft(repo, { draft, put: [], remove: [], added: [], problems: [] }, runtime);
  }, [repo, draft, runtime]);
  const title = draft?.title;
  useEffect(() => { if (title && title !== info.title) onChanged(); }, [title, info.title, onChanged]);
  if (!draft) return <div className="flex h-full items-center justify-center"><span className="loading loading-spinner" /></div>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-base-300 bg-base-100 px-3 py-1">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{draft.title}</span>
        <SyncState />
        <PublishMenu repo={repo} id={info.id} />
        <DeleteButton id={info.id} title={draft.title} onDeleted={onDeleted} />
      </div>
      <div className="grid min-h-0 flex-1 grid-rows-2 md:grid-cols-[minmax(0,1fr)_24rem] md:grid-rows-1">
        <div className="min-h-0 min-w-0">
          <Preview repo={repo} draft={draft} runtime={registry.runtime} css={css} tailwind={tailwind} onError={onError} resolveNpm={api.resolveNpm} csp={csp} />
        </div>
        <div className="min-h-0 border-t border-base-300 md:border-t-0 md:border-l">
          <Chat repo={repo} draft={draft} backend={backend} runtime={runtime} errors={errors} onTurnDone={() => setErrors([])} />
        </div>
      </div>
    </div>
  );
}

/** Whether the server has what's here; what it refused, if it did. */
function SyncState() {
  const c = useConnector();
  if (c.state === 'error') return <span role="alert" className="max-w-xs truncate text-xs text-error" title={c.error}>Not saved: {c.error}</span>;
  if (c.state === 'syncing') return <span className="text-xs text-base-content/50">Saving…</span>;
  return <span className="text-xs text-base-content/50">Saved</span>;
}

function PublishMenu({ repo, id }: { repo: Repo; id: string }) {
  const [p, setP] = useState<api.Publication | null>();
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  useEffect(() => { api.publication(id).then(setP, () => setP(null)); }, [id]);
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setProblems([]);
    try { await f(); } catch (e) {
      setProblems(e instanceof api.ApiError && e.problems.length ? e.problems : [e instanceof Error ? e.message : String(e)]);
    } finally { setBusy(false); }
  };
  // what the server publishes is its copy: everything here goes there first
  const publish = () => run(async () => { await repo.connect(api.draftUrl(id)); setP(await api.publish(id)); });
  const off = () => run(async () => {
    if (!confirm('Switch the link off? Students who open it see that it isn’t available. Publishing again switches it back on.')) return;
    await api.unpublish(id);
    setP(await api.publication(id));
  });
  const copy = async () => {
    if (!p) return;
    await navigator.clipboard.writeText(p.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const live = p && !p.revoked;
  return (
    <details className="dropdown dropdown-end">
      <summary className={`btn btn-sm ${live ? '' : 'btn-primary'}`}><Send className="size-4" /> {live ? 'Published' : 'Publish'}</summary>
      <div className="dropdown-content z-50 mt-2 flex w-80 flex-col gap-2 rounded-box border border-base-300 bg-base-100 p-3 text-sm shadow">
        {live && (
          <>
            <p>Students open it with this link. It works without an account; anyone who has it can open it.</p>
            <div className="flex gap-1">
              <input className="input input-sm min-w-0 flex-1 font-mono text-xs" readOnly value={p.url} onFocus={(e) => e.target.select()} />
              <button type="button" className="btn btn-sm btn-square" onClick={() => void copy()} title="Copy">{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</button>
            </div>
            <p className="text-xs text-base-content/60">Last published {new Date(p.updated).toLocaleString()}.</p>
          </>
        )}
        {p?.revoked && <p className="text-base-content/70">The link is switched off. Publishing switches it on again.</p>}
        {!p && <p>Publishing makes a link for your students. What they do in the lesson stays on their device.</p>}
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void publish()}>
          {busy ? <span className="loading loading-spinner loading-xs" /> : live ? 'Publish changes' : 'Publish'}
        </button>
        {live && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void off()}><Link2Off className="size-4" /> Switch the link off</button>}
        {p?.warnings.map((w) => <p key={w} className="text-warning">{w}</p>)}
        {problems.length > 0 && (
          <div role="alert" className="text-error">
            <p>It wasn’t published:</p>
            <ul className="list-disc pl-5">{problems.map((x) => <li key={x}>{x}</li>)}</ul>
          </div>
        )}
      </div>
    </details>
  );
}

function DeleteButton({ id, title, onDeleted }: { id: string; title: string; onDeleted: () => void }) {
  const remove = async () => {
    if (!confirm(`Delete “${title}”? A link you published keeps working until you switch it off.`)) return;
    await api.deleteDraft(id);
    onDeleted();
  };
  return <button type="button" className="btn btn-ghost btn-sm btn-square" title="Delete" onClick={() => void remove()}><Trash2 className="size-4" /></button>;
}
