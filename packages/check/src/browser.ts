/**
 * The checks in the page: TypeScript in a worker, esbuild-wasm, images decoded by the browser, a viz's code run and
 * rendered in sandboxed frames. Everything is loaded on the first check, not with the page.
 */
import * as esbuild from 'esbuild-wasm';
import wasmURL from 'esbuild-wasm/esbuild.wasm?url';
import runtimeUrl from '../pack/viz-runtime.json?url';
import type { Platform, VizCheck } from './index.ts';
import type { VizRuntime } from './pack.ts';
import { render, runInFrame } from './render.ts';

let ready: Promise<void> | undefined;
let runtime: Promise<VizRuntime> | undefined;
let worker: Worker | undefined;
let next = 0;
const waiting = new Map<number, { resolve: (e: string[]) => void; reject: (e: Error) => void }>();

function typeWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (e: MessageEvent<{ id: number; errors?: string[]; failed?: string }>) => {
    const w = waiting.get(e.data.id);
    waiting.delete(e.data.id);
    if (e.data.failed !== undefined) w?.reject(new Error(e.data.failed));
    else w?.resolve(e.data.errors ?? []);
  });
  worker.addEventListener('error', (e) => {
    for (const w of waiting.values()) w.reject(new Error(e.message || 'the type checker stopped'));
    waiting.clear();
    worker = undefined;
  });
  return worker;
}

export const browserPlatform: Platform = {
  async build(o) {
    ready ??= esbuild.initialize({ wasmURL, worker: true });
    await ready;
    return esbuild.build(o);
  },
  async typecheck(kind, files, ignore) {
    const id = next++;
    const errors = await new Promise<string[]>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      typeWorker().postMessage({ id, kind, files });
    });
    return errors.filter((m) => !ignore(m));
  },
  async decodeImage(name, bytes) {
    if (!/\.(png|jpe?g)$/i.test(name)) throw new Error(`${name}: ?pixels takes a .png or .jpg`);
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d canvas here');
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    return { width: bitmap.width, height: bitmap.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  },
  runChecks: (js) => runInFrame<VizCheck[]>(js),
  render,
  vizRuntime() {
    runtime ??= fetch(runtimeUrl).then((r) => {
      if (!r.ok) throw new Error(`the viz runtime: ${r.status}`);
      return r.json() as Promise<VizRuntime>;
    });
    return runtime;
  },
};
