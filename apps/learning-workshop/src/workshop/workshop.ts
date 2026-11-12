import { stableId, type Repo } from '@gestalts/client';
import type { Item } from '@gestalts/view';

/** One vibecoded view is one yml. */
export const VIEW = 'view@1';

export type VibeView = { id: string; title: string; source: string; reads: string[]; writes: string[] };

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function asView(i: Item): VibeView {
  const { title, source, reads, writes } = i.value;
  return { id: i.id, title: String(title ?? ''), source: String(source ?? ''), reads: strings(reads), writes: strings(writes) };
}

const STARTER = `export default function View() {
  return <div className="flex h-full items-center justify-center text-base-content/60">Tell me what this should be.</div>;
}
`;

export async function createView(repo: Repo, title: string): Promise<string> {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'view';
  const id = `${slug}-${stableId('view', `${title}:${Date.now()}`).slice(0, 8)}`;
  await repo.put({ id, gestalt: VIEW, title, source: STARTER, reads: [], writes: [] });
  return id;
}

/** The view as the agent sees it. */
export function filesOf(v: VibeView): Record<string, string> {
  return { 'view.tsx': v.source, 'view.json': `${JSON.stringify({ title: v.title, reads: v.reads, writes: v.writes }, null, 2)}\n` };
}

/** What a turn's changed files make of the view. A file deleted, or a `view.json` that doesn't parse, changes nothing. */
export function applyFiles(v: VibeView, files: Record<string, string | null>): VibeView {
  const next = { ...v };
  if (typeof files['view.tsx'] === 'string') next.source = files['view.tsx'];
  if (typeof files['view.json'] === 'string') {
    try {
      const m = JSON.parse(files['view.json']) as { title?: unknown; reads?: unknown; writes?: unknown };
      if (typeof m.title === 'string' && m.title.trim()) next.title = m.title;
      next.reads = strings(m.reads);
      next.writes = strings(m.writes);
    } catch { /* the check reports it */ }
  }
  return next;
}

export const saveView = (repo: Repo, v: VibeView) => repo.put({ id: v.id, gestalt: VIEW, title: v.title, source: v.source, reads: v.reads, writes: v.writes });
