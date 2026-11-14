import type { WasmRepo } from '../wasm/gestalts.js';

/** The `WasmRepo` methods the `Repo` uses, by name. */
export const METHODS = [
  'reindex', 'reload', 'collectNodeBlobs', 'isDeleted', 'query', 'get', 'subscribe', 'unsubscribe', 'takeDeltas',
  'subscribeBeliefs', 'takeBeliefDeltas', 'subscribeOutline', 'takeOutlineDeltas', 'put', 'delete', 'health',
  'readBlob', 'writeBlob', 'gestalts', 'syncFetch', 'syncMerge', 'syncPush',
] as const satisfies readonly (keyof WasmRepo)[];

type Method = (typeof METHODS)[number];
type Fn<K extends Method> = WasmRepo[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never;

/**
 * The core as the `Repo` sees it: a `WasmRepo`'s methods, each answering later, so the core can run in a worker,
 * where loading and indexing every yml doesn't hold up the page. `free` lets go of it.
 */
export type Core = { [K in Method]: Fn<K> } & { free(): void };

/** A core on this thread: the native app's, whose storage is the page's (`HostStorage` callbacks). */
export function localCore(wasm: WasmRepo): Core {
  const core = Object.fromEntries(METHODS.map((m) => [m, async (...a: unknown[]) => (wasm[m] as (...x: unknown[]) => unknown).apply(wasm, a)]));
  return { ...(core as Omit<Core, 'free'>), free: () => wasm.free() };
}

/** What opens a core in the worker: the user's folder in OPFS, or the node's. */
export type WorkerOpen = { kind: 'dir' | 'node'; where: string; decks: { source: string; url: string }[]; gestalts: string[] };

/** A call to the worker, and its answer. */
export type ToWorker = { id: number; method: Method; args: unknown[] } | { id: number; method: 'open'; args: [WorkerOpen] } | { id: number; method: 'free'; args: [] };
export type FromWorker = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

/**
 * A core in a worker of its own, opened at `open`. Each call runs as it arrives, as on this thread; an error comes
 * back as an `Error` with the core's message.
 */
export async function workerCore(open: WorkerOpen): Promise<Core> {
  const worker = new Worker(new URL('./core.worker.ts', import.meta.url), { type: 'module', name: 'gestalts-core' });
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let next = 0;
  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const w = waiting.get(e.data.id);
    if (!w) return;
    waiting.delete(e.data.id);
    if (e.data.ok) w.resolve(e.data.value);
    else w.reject(new Error(e.data.error));
  };
  // a worker that can't start (or crashes) fails what's waiting rather than leaving it hanging
  worker.onerror = (e) => {
    const error = new Error(`the core's worker failed: ${e.message || 'it could not start'}`);
    waiting.forEach((w) => w.reject(error));
    waiting.clear();
  };
  const call = (method: ToWorker['method'], args: unknown[]): Promise<unknown> => new Promise((resolve, reject) => {
    const id = next++;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, method, args } as ToWorker);
  });
  try {
    await call('open', [open]);
  } catch (e) {
    worker.terminate();
    throw e;
  }
  const core = Object.fromEntries(METHODS.map((m) => [m, (...a: unknown[]) => call(m, a)]));
  return { ...(core as Omit<Core, 'free'>), free: () => { void call('free', []).finally(() => worker.terminate()); } };
}
