/// <reference lib="webworker" />
/**
 * The core in a worker: opening the folder, reading and indexing every yml, and answering queries happen here, off the
 * page's thread. `core.ts` is the other side.
 */
import init, { WasmRepo } from '../wasm/gestalts.js';
import type { FromWorker, ToWorker } from './core';

let repo: WasmRepo | undefined;

const message = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : String(e));

async function perform(c: ToWorker): Promise<unknown> {
  if (c.method === 'open') {
    const [o] = c.args;
    await init();
    repo = o.kind === 'node' ? await WasmRepo.openNode(o.where, o.decks, o.gestalts) : await WasmRepo.open(o.where, o.decks, o.gestalts);
    return null;
  }
  if (c.method === 'free') {
    repo?.free();
    repo = undefined;
    return null;
  }
  if (!repo) throw new Error('the core isn\'t open');
  return (repo[c.method] as (...a: unknown[]) => unknown).apply(repo, c.args);
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const { id } = e.data;
  // each runs as it arrives and is answered once done, as on the page: a query made while a put is under way may
  // answer first, which is why the Repo queues its writes
  perform(e.data).then(
    (value) => postMessage({ id, ok: true, value } satisfies FromWorker),
    (error: unknown) => postMessage({ id, ok: false, error: message(error) } satisfies FromWorker),
  );
};
