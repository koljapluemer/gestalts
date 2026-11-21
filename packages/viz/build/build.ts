/**
 * Builds a viz folder (`viz.ts`, optional `files/`, `node_modules` for extra packages) into one offline HTML page with
 * the runtime, and runs its checks in node. Images imported as `files/<name>?pixels` are decoded here, so the model
 * gets pixels synchronously, in the page and in the checks alike.
 *
 *   node build.ts build <dir>   writes <dir>/dist/index.html
 *   node build.ts check <dir>   runs the viz's checks; exits non-zero if any fails
 */
import { build, type BuildOptions, type Plugin } from 'esbuild';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

import { LOADERS, MAX_BYTES, TARGET, checksEntry, pageEntry, pageHtml, pixelsModule } from '../src/page.ts';

export { MAX_BYTES };

/** the runtime's sources: `@gestalts/viz` resolves here whatever the viz folder has installed */
const RUNTIME = resolve(import.meta.dirname, '../src');

export function decodeImage(path: string, bytes: Buffer): { width: number; height: number; data: Uint8Array } {
  const ext = extname(path).toLowerCase();
  if (ext === '.png') {
    const png = PNG.sync.read(bytes);
    return { width: png.width, height: png.height, data: png.data };
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    return { width: img.width, height: img.height, data: img.data };
  }
  throw new Error(`${path}: ?pixels takes a .png or .jpg`);
}

const pixels: Plugin = {
  name: 'pixels',
  setup(b) {
    b.onResolve({ filter: /\?pixels$/ }, (a) => ({ path: resolve(a.resolveDir, a.path.slice(0, -'?pixels'.length)), namespace: 'pixels' }));
    b.onLoad({ filter: /.*/, namespace: 'pixels' }, async (a) => ({
      loader: 'js', watchFiles: [a.path], contents: pixelsModule(decodeImage(a.path, await readFile(a.path))),
    }));
  },
};

const common = (dir: string, contents: string): BuildOptions => ({
  stdin: { contents, resolveDir: dir, loader: 'ts', sourcefile: 'entry.ts' },
  bundle: true,
  write: false,
  outdir: join(dir, 'dist'),
  target: TARGET,
  logLevel: 'silent',
  alias: { '@gestalts/viz': RUNTIME },
  plugins: [pixels],
  loader: { ...LOADERS },
});

/** The viz in `dir` as one self-contained page. */
export async function buildPage(dir: string): Promise<string> {
  const r = await build({ ...common(resolve(dir), pageEntry(join(resolve(dir), 'viz.ts'))), format: 'iife', minify: true, legalComments: 'none' });
  const out = (ext: string) => (r.outputFiles ?? []).filter((f) => f.path.endsWith(ext)).map((f) => f.text).join('\n');
  return pageHtml(out('.js'), out('.css'));
}

export type CheckResult = { name: string; ok: boolean; message?: string };

/** Runs `checks` of the viz in `dir` (and its model and scene once at the defaults), in node. */
export async function runVizChecks(dir: string): Promise<CheckResult[]> {
  const r = await build({
    ...common(resolve(dir), checksEntry(join(resolve(dir), 'viz.ts'))),
    format: 'esm',
    platform: 'node',
  });
  const js = r.outputFiles?.find((f) => f.path.endsWith('.js'));
  if (!js) throw new Error('nothing built');
  const tmp = await mkdtemp(join(tmpdir(), 'viz-check-'));
  try {
    const file = join(tmp, 'checks.mjs');
    await writeFile(file, js.text);
    const mod = (await import(pathToFileURL(file).href)) as { results: CheckResult[] };
    return mod.results;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function main(args: string[]): Promise<number> {
  const [cmd, dir] = args;
  if ((cmd !== 'build' && cmd !== 'check') || !dir) {
    console.error('usage: node build.ts build|check <dir>');
    return 2;
  }
  try {
    if (cmd === 'build') {
      const html = await buildPage(dir);
      await mkdir(join(dir, 'dist'), { recursive: true });
      await writeFile(join(dir, 'dist', 'index.html'), html);
      console.log(`built ${join(dir, 'dist', 'index.html')} (${Math.round(Buffer.byteLength(html) / 1024)} KB)`);
      return 0;
    }
    const results = await runVizChecks(dir);
    for (const c of results) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.message ? `\n     ${c.message.replaceAll('\n', '\n     ')}` : ''}`);
    return results.every((c) => c.ok) ? 0 : 1;
  } catch (e) {
    const errors = (e as { errors?: { text: string; location?: { file: string; line: number } }[] }).errors;
    if (errors?.length) for (const x of errors) console.error(`${x.location ? `${x.location.file}:${x.location.line}: ` : ''}${x.text}`);
    else console.error(e instanceof Error ? e.message : e);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2));
