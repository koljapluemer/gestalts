import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import { registry } from 'virtual:gestalts-plugins';
import { useOpenRepo, type Repo } from '@gestalts/client';
import { FrameView, closedCsp, type RunnableView, type ViewEnv } from '@gestalts/host';
import type { JsonMap } from '@gestalts/view';
import { LESSON_ID, parseManifest, type LessonManifest } from '@gestalts/workshop/lesson';
import tailwind from '@tailwindcss/browser?raw';
import css from './app.css?inline';

/**
 * One lesson, from its link `/l/<lesson>`: its current version's manifest, its view, and its ymls mounted read-only
 * under a folder of this device's own (OPFS, by lesson, not by version), so what a student did survives a new version
 * and never leaves the device. The view runs under the closed CSP: it reaches no server.
 */
type Loaded = { id: string; manifest: LessonManifest; base: string; js: string };

class Gone extends Error {}

const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* not kept: fine for a lesson */ } },
  remove(k: string) { try { localStorage.removeItem(k); } catch { /* nothing kept */ } },
};

function lessonId(): string | null {
  const m = /^\/l\/([^/]+)\/?$/.exec(location.pathname);
  return m && LESSON_ID.test(m[1]) ? m[1] : null;
}

async function load(id: string): Promise<Loaded> {
  const r = await fetch(`/l/${id}/current`, { cache: 'no-cache' });
  if (r.status === 404 || r.status === 410) throw new Gone();
  if (!r.ok) throw new Error(`the lesson couldn't be loaded (${r.status})`);
  const { manifest: path } = (await r.json()) as { manifest?: string };
  if (typeof path !== 'string' || !new RegExp(`^/lessons/${id}/[A-Za-z0-9_-]+/manifest\\.json$`).test(path)) throw new Error('the lesson points somewhere it may not');
  const manifest = parseManifest(await (await fetch(path)).json());
  const base = path.slice(0, -'manifest.json'.length);
  const view = await fetch(base + manifest.view);
  if (!view.ok) throw new Error(`the lesson's view couldn't be loaded (${view.status})`);
  return { id, manifest, base, js: await view.text() };
}

export function Player() {
  const id = useMemo(() => lessonId(), []);
  const [lesson, setLesson] = useState<Loaded>();
  const [error, setError] = useState<{ gone?: boolean; message?: string }>();
  useEffect(() => {
    if (!id) return;
    // asked once: Safari deletes what a site stored after a week without a visit, unless it's persisted
    void navigator.storage?.persist?.().catch(() => false);
    load(id).then((l) => {
      if (l.manifest.runtime !== registry.runtime.version) {
        // the lesson moved on to another player since this page loaded: the link serves that one now
        const tried = `player:reloaded:${id}:${l.manifest.runtime}`;
        if (!sessionStorage.getItem(tried)) {
          sessionStorage.setItem(tried, '1');
          location.reload();
          return;
        }
        setError({ message: 'This lesson needs another version of the player, which isn’t here.' });
        return;
      }
      document.title = l.manifest.title;
      setLesson(l);
    }, (e: unknown) => setError(e instanceof Gone ? { gone: true } : { message: e instanceof Error ? e.message : String(e) }));
  }, [id]);

  if (!id) return <Notice title="No lesson here">Open the link your teacher gave you.</Notice>;
  if (error?.gone) return <Notice title="This lesson isn’t available">The link was switched off or has expired. Ask your teacher for a new one.</Notice>;
  if (error) return <Notice title="The lesson couldn’t start">{error.message}</Notice>;
  if (!lesson) return <Spinner />;
  return <Lesson lesson={lesson} />;
}

function Lesson({ lesson }: { lesson: Loaded }) {
  const { id, manifest, base } = lesson;
  const generationKey = `player:generation:${id}`;
  const stateKey = `player:state:${id}`;
  const [generation, setGeneration] = useState(() => Number(store.get(generationKey) ?? 0) || 0);
  const dir = generation ? `lesson-${id}-${generation}` : `lesson-${id}`;
  const source = useMemo(() => ({
    dir,
    decks: [{ source: `lesson/${id}`, url: new URL(base, location.origin).href.replace(/\/$/, '') }],
    gestalts: registry.gestalts,
  }), [dir, id, base]);
  const { repo, error } = useOpenRepo(source);

  const startFresh = () => {
    if (!confirm('Start this lesson again from the beginning? What you did in it on this device is deleted.')) return;
    const old = { dir, repo };
    store.set(generationKey, String(generation + 1));
    store.remove(stateKey);
    setGeneration(generation + 1);
    void forget(old.dir, old.repo);
  };

  return (
    <div className="flex h-dvh flex-col bg-base-200">
      <header className="flex min-h-0 items-center gap-2 border-b border-base-300 bg-base-100 px-3 py-1">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{manifest.title}</span>
        <button type="button" className="btn btn-ghost btn-xs" onClick={startFresh} title="Start again, for the next person on this device">
          <RotateCcw className="size-3.5" /> Start fresh
        </button>
      </header>
      <main className="min-h-0 flex-1">
        {error && <Notice title="The lesson couldn’t open its data">{error}</Notice>}
        {!error && !repo && <Spinner />}
        {repo && <Run key={dir} repo={repo} lesson={lesson} stateKey={stateKey} />}
      </main>
    </div>
  );
}

/** Lets go of a folder this device no longer uses. Best effort: a browser that won't is no worse off. */
async function forget(dir: string, repo: Repo | undefined) {
  repo?.dispose();
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(dir, { recursive: true });
  } catch { /* still open somewhere, or no OPFS: it stays, unused */ }
}

function Run({ repo, lesson, stateKey }: { repo: Repo; lesson: Loaded; stateKey: string }) {
  const { manifest, js, id } = lesson;
  const view = useMemo<RunnableView>(() => ({
    id: `lesson-${id}`,
    title: manifest.title,
    js,
    npm: Object.keys(manifest.npm),
    npmUrls: Object.fromEntries(Object.entries(manifest.npm).map(([spec, path]) => [spec, new URL(path, location.origin).href])),
    scope: { reads: manifest.reads, writes: manifest.writes },
  }), [id, manifest, js]);
  const csp = useMemo(() => closedCsp({ scripts: [`${location.origin}/npm/`] }), []);
  const [state] = useState<JsonMap>(() => { try { return JSON.parse(store.get(stateKey) ?? '{}') as JsonMap; } catch { return {}; } });
  const env = useMemo<ViewEnv>(() => ({
    setState: (s) => store.set(stateKey, JSON.stringify(s)),
    setTitle: () => {},
    setParams: () => {},
    openView: () => false,
  }), [stateKey]);
  return <FrameView repo={repo} view={view} runtime={registry.runtime} css={css} tailwind={tailwind} params={{}} state={state} env={env} csp={csp} />;
}

function Spinner() {
  return <div className="flex h-full items-center justify-center"><span className="loading loading-spinner" /></div>;
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-dvh items-center justify-center bg-base-200 p-4">
      <div role="status" className="max-w-sm rounded-box bg-base-100 p-6 text-center shadow">
        <h1 className="mb-2 text-lg font-semibold">{title}</h1>
        <p className="text-base-content/70">{children}</p>
      </div>
    </div>
  );
}
