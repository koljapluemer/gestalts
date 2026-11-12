import { useEffect, useMemo } from 'react';
import { registry } from 'virtual:gestalts-plugins';
import { FrameView, type RunnableView, type ViewEnv } from '@gestalts/host';
import type { Repo } from '@gestalts/client';
import type { JsonMap, ViewError } from '@gestalts/view';
import { compile } from '@gestalts/view/compile';
import tailwind from '@tailwindcss/browser?raw';
import css from '../app.css?inline';
import type { VibeView } from './workshop';

// a preview shows one view, and nothing else to open
const ENV: ViewEnv = { setState: () => {}, setTitle: () => {}, setParams: () => {}, openView: () => false };
const STATE: JsonMap = {};

/** A vibecoded view, compiled in the browser and run the way any view runs. */
export function Preview({ repo, view, onError }: { repo: Repo; view: VibeView; onError: (e: ViewError) => void }) {
  const compiled = useMemo(() => compile(view.source), [view.source]);
  const compileMessage = compiled.ok ? undefined : compiled.errors.map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message)).join('\n');
  useEffect(() => {
    if (compileMessage) onError({ kind: 'compile', message: compileMessage, at: new Date().toISOString() });
  }, [compileMessage, onError]);
  const runnable = useMemo<RunnableView | undefined>(() => (compiled.ok
    ? { id: view.id, title: view.title, js: compiled.js, npm: compiled.npm, scope: { reads: view.reads, writes: view.writes } }
    : undefined), [compiled, view.id, view.title, view.reads, view.writes]);
  if (!runnable) return <div role="alert" className="alert alert-error m-4 font-mono text-sm whitespace-pre-wrap">{compileMessage}</div>;
  return <FrameView key={runnable.js} repo={repo} view={runnable} runtime={registry.runtime} css={css} tailwind={tailwind} params={{}} state={STATE} env={ENV} onError={onError} />;
}
