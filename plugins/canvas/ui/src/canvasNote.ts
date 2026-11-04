import { asMap, field, fold, hashing, type IndexedNote, type Json, type Query, type Repo } from '@gestalts/sdk';
import type { WireNode } from './model';

/** Canvas notes of the old form (`canvas@1`, `canvas-of` the host), retired ones included. */
export const OLD_CANVASES: Query = { tagsAll: ['canvas'] };

/**
 * A note's canvas as stored: the host's `canvas` key, else (not folded in yet) the `canvas@1` note that is
 * `canvas-of` it. `stale`: old canvas notes edited after they were folded in.
 */
export function canvasOf(host: IndexedNote, oldCanvases: IndexedNote[]) {
  const attached = fold.attached(oldCanvases, host.id, 'canvas');
  const read = fold.readCanvas(host, attached);
  return {
    nodes: read.value,
    from: read.from,
    stale: fold.staleFolds(fold.folded(oldCanvases, host.id, 'canvas'), 'canvas', hashing),
    unwritable: fold.unwritable(host),
  };
}

/** The ids of the notes on a host's canvas. */
export const canvasLinksOf = (host: IndexedNote, oldCanvases: IndexedNote[]) => fold.canvasLinks(canvasOf(host, oldCanvases).nodes);

/** Saves the nodes on the host (keeping other keys of its `canvas`), and retires an old canvas note on the way. */
export async function saveCanvas(repo: Repo, hostKey: string, nodes: WireNode[]): Promise<void> {
  const host = repo.get(hostKey);
  if (!host) throw new Error(`No note ${hostKey}`);
  const attached = fold.attached(repo.query(OLD_CANVASES), host.id, 'canvas');
  const value: Json = { ...asMap(field(host, 'canvas') ?? null), nodes: nodes.map((n) => ({ ...n })) };
  await fold.writeFold(repo, hostKey, fold.foldWrites(host, 'canvas', value, attached, hashing));
}

/** An old canvas note edited after the fold: take its nodes into the host ("use that version"), or keep the host's. */
export async function resolveStale(repo: Repo, hostKey: string, stale: IndexedNote, take: boolean): Promise<void> {
  const host = repo.get(hostKey);
  if (!host) return;
  if (take) await fold.writeFold(repo, hostKey, fold.foldWrites(host, 'canvas', fold.adopt(host, stale, 'canvas', hashing), [], hashing));
  await repo.putValue(stale.key, fold.acknowledge(stale, 'canvas', hashing));
}
