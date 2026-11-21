/**
 * A viz: the way the workshop builds it. Its types, its own `checks`, the build into one offline page (esbuild, on
 * the runtime's recorded sources and npm packages from esm.sh), and, where there is a browser, a render at 360 and
 * 1000 px, light and dark, with screenshots and the still.
 */
import type { BuildOptions, Loader, Plugin } from 'esbuild-wasm';
import { LOADERS, TARGET, checksEntry, pageEntry, pageHtml, pixelsModule } from '@gestalts/viz/page';
import { packageName, result, type CheckItem, type CheckResult, type Files, type Platform } from './index.ts';
import type { VizRuntime } from './pack.ts';

const PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/;
const NPM = 'https://esm.sh';
const W = '/w';

/** The packages `package.json` names, by name; or what's wrong with it. */
export function packagesOf(text: string | undefined): { packages: Record<string, string>; problems: string[] } {
  if (text === undefined) return { packages: {}, problems: [] };
  let deps: unknown;
  try {
    deps = (JSON.parse(text) as { dependencies?: unknown }).dependencies ?? {};
  } catch (e) {
    return { packages: {}, problems: [`package.json: ${(e as Error).message}`] };
  }
  if (typeof deps !== 'object' || deps === null || Array.isArray(deps)) return { packages: {}, problems: ['package.json: `dependencies` maps names to versions'] };
  const packages: Record<string, string> = {};
  const problems: string[] = [];
  for (const [name, v] of Object.entries(deps)) {
    const version = typeof v === 'string' ? v.replace(/^[\^~=]/, '') : '';
    if (!PACKAGE.test(name) || !VERSION.test(version)) problems.push(`package.json: ${name}@${String(v)} isn't a package at an exact version, like "d3": "7.9.0"`);
    else packages[name] = version;
  }
  return { packages, problems };
}

const ext = (p: string) => { const m = /\.[^./]+$/.exec(p); return m ? m[0].toLowerCase() : ''; };
const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/'));
function join(dir: string, rel: string): string {
  const parts = rel.startsWith('/') ? [] : dir.split('/');
  for (const s of rel.split('/')) {
    if (s === '..') parts.pop();
    else if (s !== '.' && s !== '') parts.push(s);
  }
  return `/${parts.filter(Boolean).join('/')}`;
}
const loaderOf = (p: string): Loader => {
  const e = ext(p);
  if (e === '.ts' || e === '.mts') return 'ts';
  if (e === '.tsx') return 'tsx';
  if (e === '.js' || e === '.mjs' || e === '.cjs') return 'js';
  if (e === '.css') return 'css';
  if (e === '.json') return 'json';
  return (LOADERS as Record<string, Loader>)[e] ?? 'text';
};
const bytesOf = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Resolves and loads everything a viz build reads, without a file system. */
function sources(files: Files, packages: Record<string, string>, runtime: VizRuntime, platform: Platform): Plugin {
  const user = (p: string) => (p.startsWith(`${W}/`) ? files[p.slice(W.length + 1)] : undefined);
  const findUser = (p: string) => [p, `${p}.ts`, `${p}/index.ts`].find((c) => user(c) !== undefined);
  return {
    name: 'gestalts-sources',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => {
        if (a.path.startsWith('data:')) return undefined;
        const from = a.namespace;
        if (from === 'npm') return { path: new URL(a.path, a.importer).href, namespace: 'npm' };
        if (from === 'rt') {
          const to = runtime.resolved[`${a.importer}\0${a.path}`];
          return to ? { path: to, namespace: 'rt' } : { errors: [{ text: `the runtime's ${a.importer} imports ${a.path}, which wasn't recorded: run the pack again` }] };
        }
        // the entry and the viz's own files
        const dir = from === 'user' ? dirOf(a.importer) : W;
        if (a.path.endsWith('?pixels')) return { path: join(dir, a.path.slice(0, -'?pixels'.length)), namespace: 'pixels' };
        if (a.path.startsWith('.') || a.path.startsWith('/')) {
          const found = findUser(join(dir, a.path));
          return found ? { path: found, namespace: 'user' } : { errors: [{ text: `cannot find ${a.path}` }] };
        }
        if (a.path === '@gestalts/viz' || a.path.startsWith('@gestalts/viz/')) {
          const to = runtime.resolved[`\0${a.path}`];
          return to ? { path: to, namespace: 'rt' } : { errors: [{ text: `${a.path} isn't part of @gestalts/viz: there are @gestalts/viz and @gestalts/viz/tex` }] };
        }
        const name = packageName(a.path);
        const version = packages[name];
        if (!version) return { errors: [{ text: `import "${a.path}": add "${name}" to package.json's dependencies with an exact version` }] };
        return { path: `${NPM}/${name}@${version}${a.path.slice(name.length)}?bundle&target=${TARGET}`, namespace: 'npm' };
      });
      b.onLoad({ filter: /.*/, namespace: 'user' }, (a) => ({ contents: user(a.path), loader: loaderOf(a.path) }));
      b.onLoad({ filter: /.*/, namespace: 'rt' }, (a) => {
        const bin = runtime.binary[a.path];
        return { contents: bin !== undefined ? bytesOf(bin) : runtime.files[a.path], loader: loaderOf(a.path), resolveDir: dirOf(a.path) };
      });
      b.onLoad({ filter: /.*/, namespace: 'pixels' }, async (a) => {
        const bytes = user(a.path);
        if (!(bytes instanceof Uint8Array)) return { errors: [{ text: `${a.path.slice(W.length + 1)}: no such image in files/` }] };
        return { contents: pixelsModule(await platform.decodeImage(a.path, bytes)), loader: 'js' };
      });
      b.onLoad({ filter: /.*/, namespace: 'npm' }, async (a) => {
        const r = await fetch(a.path);
        if (!r.ok) return { errors: [{ text: `${a.path}: ${r.status} ${r.statusText}` }] };
        return { contents: await r.text(), loader: 'js' };
      });
    },
  };
}

type BuildError = { errors?: { text: string; location?: { file: string; line: number } | null }[] };
const buildErrors = (e: unknown) => {
  const errors = (e as BuildError).errors;
  return errors?.length
    ? errors.map((x) => `${x.location ? `${x.location.file.replace(`${W}/`, '')}:${x.location.line}: ` : ''}${x.text}`).join('\n')
    : e instanceof Error ? e.message : String(e);
};

/**
 * Checks the viz in `files` (`viz.ts`, optional `package.json` and `files/<name>` as bytes or text). `built` and
 * `still` come back only when everything passed.
 */
export async function checkViz(files: Files, platform: Platform): Promise<CheckResult> {
  const items: CheckItem[] = [];
  const source = files['viz.ts'];
  if (typeof source !== 'string') return result([{ ok: false, name: 'viz.ts', message: 'viz.ts is missing' }]);
  const pkg = files['package.json'];
  const { packages, problems } = packagesOf(typeof pkg === 'string' ? pkg : undefined);
  if (problems.length) items.push({ ok: false, name: 'package.json', message: problems.join('\n') });

  const texts = Object.fromEntries(Object.entries(files).filter((e): e is [string, string] => typeof e[1] === 'string' && /\.(ts|d\.ts)$/.test(e[0])));
  const names = Object.keys(packages);
  const typeErrors = await platform.typecheck('viz', texts, (m) => names.some((n) => m.includes(`'${n}`) && /TS2307|TS7016/.test(m)));
  items.push({ ok: typeErrors.length === 0, name: 'typecheck', message: typeErrors.join('\n') });

  const runtime = await platform.vizRuntime();
  const options = (contents: string): BuildOptions => ({
    stdin: { contents, resolveDir: W, loader: 'ts', sourcefile: 'entry.ts' },
    bundle: true, write: false, outdir: '/out', target: TARGET, logLevel: 'silent',
    plugins: [sources(files, packages, runtime, platform)], loader: { ...LOADERS },
  });

  try {
    const r = await platform.build({ ...options(checksEntry(`${W}/viz.ts`)), format: 'esm', platform: 'neutral', mainFields: ['module', 'main'] });
    const js = r.outputFiles?.find((f) => f.path.endsWith('.js'))?.text;
    if (!js) throw new Error('nothing built');
    const checks = await platform.runChecks(js);
    if (checks.length === 0) items.push({ ok: false, name: 'checks', message: 'the viz has no `checks`: add expectations about its model' });
    for (const c of checks) items.push({ ok: c.ok, name: `check: ${c.name}`, message: c.message });
  } catch (e) {
    items.push({ ok: false, name: 'checks', message: buildErrors(e) });
  }

  let html: string | undefined;
  try {
    const r = await platform.build({ ...options(pageEntry(`${W}/viz.ts`)), format: 'iife', minify: true, legalComments: 'none' });
    const out = (e: string) => (r.outputFiles ?? []).filter((f) => f.path.endsWith(e)).map((f) => f.text).join('\n');
    html = pageHtml(out('.js'), out('.css'));
    items.push({ ok: true, name: `build: ${Math.round(new TextEncoder().encode(html).length / 1024)} KB` });
  } catch (e) {
    items.push({ ok: false, name: 'build', message: buildErrors(e) });
  }

  if (!html) return result(items);
  if (!platform.render) {
    items.push({ ok: true, name: 'render: skipped, no browser here' });
    const done = result(items);
    return done.ok ? { ...done, built: html } : done;
  }
  const rendered = await platform.render(html);
  items.push({ ok: rendered.problems.length === 0, name: 'render at 360 and 1000 px, light and dark', message: rendered.problems.join('\n') });
  const done = result(items, { shots: rendered.shots });
  return done.ok ? { ...done, built: html, still: rendered.still } : done;
}
