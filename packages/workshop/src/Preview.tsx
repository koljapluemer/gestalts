import { useEffect, useMemo } from 'react';
import { FrameView, type FrameRuntime, type RunnableView, type ViewEnv } from '@gestalts/host';
import type { Repo } from '@gestalts/client';
import type { JsonMap, ViewError } from '@gestalts/view';
import { compile } from '@gestalts/view/compile';
import type { Draft } from './draft';

// a preview shows one view, and nothing else to open
const ENV: ViewEnv = { setState: () => {}, setTitle: () => {}, setParams: () => {}, openView: () => false };
const STATE: JsonMap = {};

/**
 * A draft's view, compiled in the browser and run the way any view runs, against `repo`. `css` and `tailwind` are what
 * the app's views are styled with.
 */
export function Preview({ repo, draft, runtime, css, tailwind, onError }: {
  repo: Repo; draft: Draft; runtime: FrameRuntime; css: string; tailwind?: string; onError: (e: ViewError) => void;
}) {
  const compiled = useMemo(() => compile(draft.source), [draft.source]);
  const compileMessage = compiled.ok ? undefined : compiled.errors.map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message)).join('\n');
  useEffect(() => {
    if (compileMessage) onError({ kind: 'compile', message: compileMessage, at: new Date().toISOString() });
  }, [compileMessage, onError]);
  const runnable = useMemo<RunnableView | undefined>(() => (compiled.ok
    ? { id: draft.id, title: draft.title, js: compiled.js, npm: compiled.npm, scope: { reads: draft.reads, writes: draft.writes } }
    : undefined), [compiled, draft.id, draft.title, draft.reads, draft.writes]);
  if (!runnable) return <div role="alert" className="alert alert-error m-4 font-mono text-sm whitespace-pre-wrap">{compileMessage}</div>;
  return <FrameView key={runnable.js} repo={repo} view={runnable} runtime={runtime} css={css} tailwind={tailwind} params={{}} state={STATE} env={ENV} onError={onError} />;
}
