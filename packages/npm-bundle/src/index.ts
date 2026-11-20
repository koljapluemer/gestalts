/**
 * npm packages for views, bundled here and pinned, so a student's device loads them from the lesson's own domain and
 * not from a CDN that sees every request (and that school firewalls block).
 *
 * A specifier (`three`, `three/addons/controls/OrbitControls.js`, `@scope/pkg`) at an exact version is installed
 * without running any of its scripts, bundled into one ES module with what the frame's runtime provides left
 * external, and cached by specifier and version. A subpath leaves its package's root external too, so a view gets one
 * `three`, not one per addon.
 *
 * Bundling doesn't capture what a package fetches at run time (wasm, workers, fonts, model weights); the frame's CSP
 * stops that, visibly in the preview.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { RUNTIME_MODULES } from '@gestalts/view/compile';

export const REGISTRY = 'https://registry.npmjs.org';
/** No bundle is bigger: a view isn't a place for a whole framework. */
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 180_000;

const NAME = /^(@[a-z0-9][a-z0-9-._~]*\/)?[a-z0-9][a-z0-9-._~]*$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
const SUBPATH = /^[A-Za-z0-9._~@/-]+$/;

export type Specifier = { name: string; subpath: string };

/** A bare import split into its package and the path inside it. `null` for what isn't one. */
export function parseSpecifier(spec: string): Specifier | null {
  const parts = spec.split('/');
  const n = spec.startsWith('@') ? 2 : 1;
  const name = parts.slice(0, n).join('/');
  const subpath = parts.slice(n).join('/');
  if (!NAME.test(name) || (subpath && (!SUBPATH.test(subpath) || subpath.split('/').some((p) => p === '..' || p === '.' || p === '')))) return null;
  return { name, subpath };
}

/** The package an import belongs to, by its name: `three` for `three/addons/x.js`. */
export const packageName = (spec: string) => parseSpecifier(spec)?.name;

export const isVersion = (v: string) => VERSION.test(v);

/** What the frame provides; a bundle imports these, and the frame's import map resolves them. */
const RUNTIME = [...RUNTIME_MODULES, 'react/*', 'react-dom/*'];

export type Bundled = {
  specifier: string;
  version: string;
  /** the bundle, in the cache */
  file: string;
  /** sha256 of the bundle, hex */
  hash: string;
  bytes: number;
  /** other specifiers it imports, which the import map must have too (a subpath's package root) */
  needs: string[];
};

export type Options = {
  cacheDir: string;
  registry?: string;
  /** installs `name@version` into `dir/node_modules`; by default with npm, running no scripts */
  install?: (dir: string, name: string, version: string) => Promise<void>;
  fetch?: typeof fetch;
};

/** The exact version a range or dist-tag (`latest`, `0.170.0`) stands for, from the registry's dist-tags and versions. */
export async function resolveVersion(name: string, wanted: string, opts: Pick<Options, 'registry' | 'fetch'> = {}): Promise<string> {
  if (!NAME.test(name)) throw new Error(`${name}: not an npm package name`);
  if (isVersion(wanted)) return wanted;
  const get = opts.fetch ?? fetch;
  const r = await get(`${opts.registry ?? REGISTRY}/${name.replace('/', '%2f')}`, { headers: { accept: 'application/vnd.npm.install-v1+json' } });
  if (!r.ok) throw new Error(`${name}: the registry answered ${r.status}`);
  const doc = (await r.json()) as { 'dist-tags'?: Record<string, string>; versions?: Record<string, unknown> };
  const tagged = doc['dist-tags']?.[wanted || 'latest'];
  if (tagged) return tagged;
  // a prefix like `0.170` or `5`: the newest release under it
  const under = Object.keys(doc.versions ?? {}).filter((v) => isVersion(v) && !v.includes('-') && (v === wanted || v.startsWith(`${wanted}.`)));
  const newest = under.sort((a, b) => compare(b, a))[0];
  if (!newest) throw new Error(`${name}: no version ${wanted}`);
  return newest;
}

function compare(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => v.split('-')[0].split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

const run = promisify(execFile);

async function npmInstall(dir: string, name: string, version: string): Promise<void> {
  await writeFile(join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: { [name]: version } }));
  await run('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error'], { cwd: dir, timeout: INSTALL_TIMEOUT_MS });
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._@-]/g, '+');
const busy = new Map<string, Promise<unknown>>();

/** One at a time per key, whoever asks. */
function once<T>(key: string, f: () => Promise<T>): Promise<T> {
  const running = busy.get(key) as Promise<T> | undefined;
  if (running) return running;
  const p = f().finally(() => busy.delete(key));
  busy.set(key, p);
  return p;
}

/** Installs the package once per version. */
function installed(opts: Options, name: string, version: string): Promise<string> {
  const dir = join(opts.cacheDir, 'install', `${safe(name)}@${version}`);
  return once(`install ${dir}`, async () => {
    if (existsSync(join(dir, '.done'))) return dir;
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await (opts.install ?? npmInstall)(dir, name, version);
    await writeFile(join(dir, '.done'), '');
    return dir;
  });
}

/** `specifier` at `version` as one ES module, from the cache when it was bundled before. */
export function bundle(specifier: string, version: string, opts: Options): Promise<Bundled> {
  const spec = parseSpecifier(specifier);
  if (!spec) throw new Error(`${specifier}: not an npm import`);
  if (!isVersion(version)) throw new Error(`${specifier}: ${version} isn't an exact version`);
  const out = join(opts.cacheDir, 'bundles', `${safe(specifier)}@${version}`);
  return once(`bundle ${out}`, async () => {
    if (existsSync(`${out}.json`)) return JSON.parse(await readFile(`${out}.json`, 'utf8')) as Bundled;
    const dir = await installed(opts, spec.name, version);
    const needs = spec.subpath ? [spec.name] : [];
    const entry = (contents: string) => build({
      absWorkingDir: dir,
      stdin: { contents, resolveDir: dir, loader: 'js' },
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      minify: true,
      write: false,
      external: RUNTIME,
      // the package root alone: esbuild's `external` would take every subpath with it, this one included
      plugins: needs.length ? [{ name: 'root-external', setup(b) { b.onResolve({ filter: new RegExp(`^${needs[0].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`) }, (a) => ({ path: a.path, external: true })); } }] : [],
      define: { 'process.env.NODE_ENV': '"production"' },
      // a stylesheet imported for its side effect is dropped: a view styles itself
      loader: { '.css': 'empty' },
      logLevel: 'silent',
    });
    const from = JSON.stringify(specifier);
    // named exports and the default; a module without a default gets the rest. (A CommonJS package's names aren't
    // known before it runs: import its default.)
    const result = await entry(`export * from ${from};\nexport { default } from ${from};\n`).catch((e: unknown) => {
      if (!/No matching export .*"default"/s.test(e instanceof Error ? e.message : String(e))) throw e;
      return entry(`export * from ${from};\n`);
    });
    const code = result.outputFiles[0].contents;
    if (code.byteLength > MAX_BUNDLE_BYTES) throw new Error(`${specifier}@${version} bundles to ${code.byteLength} bytes, more than ${MAX_BUNDLE_BYTES}`);
    const hash = createHash('sha256').update(code).digest('hex');
    await mkdir(join(opts.cacheDir, 'bundles'), { recursive: true });
    const meta: Bundled = { specifier, version, file: `${out}.js`, hash, bytes: code.byteLength, needs };
    await writeFile(`${out}.js.tmp`, code);
    await rename(`${out}.js.tmp`, `${out}.js`);
    await writeFile(`${out}.json`, JSON.stringify(meta));
    return meta;
  });
}
