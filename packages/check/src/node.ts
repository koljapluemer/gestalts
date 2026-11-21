/**
 * The checks in Node (tests, a server): TypeScript and esbuild-wasm in this process, images by pngjs and jpeg-js, a
 * viz's checks imported as a module. No browser, so a viz isn't rendered.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as esbuild from 'esbuild-wasm';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import ts from 'typescript-js';
import type { Platform, VizCheck } from './index.ts';
import type { TypePack, VizRuntime } from './pack.ts';
import { Checker } from './typecheck.ts';

const PACK = join(import.meta.dirname, '../pack');
const load = <T>(name: string): T => {
  try {
    return JSON.parse(readFileSync(join(PACK, name), 'utf8')) as T;
  } catch (e) {
    throw new Error(`@gestalts/check: no ${name} (run \`mise run setup\`, which runs its pack script): ${(e as Error).message}`);
  }
};

const checkers: Partial<Record<'view' | 'viz', Checker>> = {};
let runtime: VizRuntime | undefined;

export const nodePlatform: Platform = {
  build: (o) => esbuild.build(o),
  async typecheck(kind, files, ignore) {
    checkers[kind] ??= new Checker(ts, load<TypePack>(`${kind}-types.json`), kind);
    return checkers[kind].check(files).filter((m) => !ignore(m));
  },
  async decodeImage(name, bytes) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.png')) {
      const png = PNG.sync.read(Buffer.from(bytes));
      return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
    }
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
      const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
      return { width: img.width, height: img.height, data: img.data };
    }
    throw new Error(`${name}: ?pixels takes a .png or .jpg`);
  },
  async runChecks(js) {
    const mod = (await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)) as { results: VizCheck[] };
    return mod.results;
  },
  async vizRuntime() {
    runtime ??= load<VizRuntime>('viz-runtime.json');
    return runtime;
  },
};
