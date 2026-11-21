/**
 * TypeScript for the page's checks, off the main thread: loaded (with its pack) only when a check first runs, then
 * kept, so later checks only parse the draft. `{id, kind, files}` in, `{id, errors}` or `{id, failed}` out.
 */
import ts from 'typescript-js';
import viewPack from '../pack/view-types.json?url';
import vizPack from '../pack/viz-types.json?url';
import type { TypePack } from './pack.ts';
import { Checker } from './typecheck.ts';

const PACKS = { view: viewPack, viz: vizPack };
const checkers: Partial<Record<'view' | 'viz', Promise<Checker>>> = {};

async function checker(kind: 'view' | 'viz'): Promise<Checker> {
  const r = await fetch(PACKS[kind]);
  if (!r.ok) throw new Error(`the ${kind} types: ${r.status}`);
  return new Checker(ts, (await r.json()) as TypePack, kind);
}

addEventListener('message', async (e: MessageEvent<{ id: number; kind: 'view' | 'viz'; files: Record<string, string> }>) => {
  const { id, kind, files } = e.data;
  try {
    checkers[kind] ??= checker(kind);
    const errors = (await checkers[kind]).check(files);
    postMessage({ id, errors });
  } catch (x) {
    delete checkers[kind];
    postMessage({ id, failed: x instanceof Error ? x.message : String(x) });
  }
});
