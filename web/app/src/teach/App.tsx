import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { LogOut, Plus, Settings as SettingsIcon } from 'lucide-react';
import * as api from './api';
import { loadChoice, saveChoice, type AgentChoice } from './agent';
import { DraftPane } from './DraftPane';
import { Settings } from './Settings';
import { Areas } from '../router';

/** Signed in: the teacher's drafts, and the one open. Signed out: the sign-in. */
export function Teach() {
  const [me, setMe] = useState<api.Me | null>();
  useEffect(() => { api.me().then(setMe, () => setMe(null)); }, []);
  if (me === undefined) return <div className="flex h-dvh items-center justify-center"><span className="loading loading-spinner" /></div>;
  if (!me) return <Login onIn={setMe} />;
  return <Teacher me={me} onOut={() => setMe(null)} />;
}

function Login({ onIn }: { onIn: (m: api.Me) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onIn(await api.login(email, password));
    } catch (err) {
      setError(err instanceof api.ApiError && err.status === 401 ? 'That email and password don’t match.' : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-dvh items-center justify-center bg-base-200 p-4">
      <div className="fixed top-2 left-4"><Areas /></div>
      <form onSubmit={(e) => void submit(e)} className="flex w-full max-w-sm flex-col gap-3 rounded-box bg-base-100 p-6 shadow">
        <h1 className="text-lg font-semibold">Sign in</h1>
        <label className="flex flex-col gap-1 text-sm">Email
          <input className="input w-full" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">Password
          <input className="input w-full" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p role="alert" className="text-sm text-error">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy}>Sign in</button>
      </form>
    </div>
  );
}

const SELECTED = 'teacher:draft';

function Teacher({ me, onOut }: { me: api.Me; onOut: () => void }) {
  const [list, setList] = useState<api.DraftInfo[]>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string | null>(() => { try { return localStorage.getItem(SELECTED); } catch { return null; } });
  const [choice, setChoice] = useState<AgentChoice>(loadChoice);
  const [settings, setSettings] = useState(false);
  const refresh = useCallback(() => api.drafts().then(setList, (e: unknown) => setError(e instanceof Error ? e.message : String(e))), []);
  useEffect(() => { void refresh(); }, [refresh]);
  const choose = (id: string | null) => {
    setSelected(id);
    try { if (id) localStorage.setItem(SELECTED, id); else localStorage.removeItem(SELECTED); } catch { /* not remembered */ }
  };
  const create = async () => {
    const title = window.prompt('What will it be? A title; you describe it in the chat next.')?.trim();
    if (!title) return;
    try {
      const d = await api.newDraft(title);
      await refresh();
      choose(d.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const signOut = async () => { await api.logout().catch(() => undefined); onOut(); };
  const current = list?.find((d) => d.id === selected);
  return (
    <div className="flex h-dvh flex-col bg-base-200">
      <header className="navbar min-h-0 gap-2 border-b border-base-300 bg-base-100 px-4 py-1">
        <Areas />
        <span className="flex-1 font-semibold">Lessons</span>
        <span className="hidden text-sm text-base-content/60 sm:inline">{me.email}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSettings(true)} title="Settings"><SettingsIcon className="size-4" /></button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void signOut()} title="Sign out"><LogOut className="size-4" /></button>
      </header>
      {error && <div role="alert" className="alert alert-error m-2">{error}</div>}
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-base-300 bg-base-100 p-2">
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void create()}><Plus className="size-4" /> New lesson</button>
          {!list && <span className="loading loading-spinner m-4" />}
          <ul className="menu menu-sm w-full p-0">
            {list?.map((d) => <li key={d.id}><button type="button" className={d.id === selected ? 'menu-active' : ''} onClick={() => choose(d.id)}>{d.title || d.id}</button></li>)}
          </ul>
          {list?.length === 0 && <p className="p-2 text-sm text-base-content/60">No lessons yet.</p>}
        </nav>
        <main className="min-w-0 flex-1">
          {current
            ? <DraftPane key={current.id} info={current} agent={choice} onChanged={() => void refresh()} onDeleted={() => { choose(null); void refresh(); }} />
            : <div className="flex h-full items-center justify-center p-4 text-center text-base-content/60">Pick a lesson, or make a new one.</div>}
        </main>
      </div>
      {settings && <Settings choice={choice} onClose={() => setSettings(false)} onSave={(c) => { saveChoice(c); setChoice(c); setSettings(false); }} />}
    </div>
  );
}
