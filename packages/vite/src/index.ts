/**
 * What an app builds with, as the virtual module `virtual:gestalts-plugins`. `distribution.yml` next to the app names
 * the distribution and lists its plugins, as folders. Each plugin's `view.tsx` is compiled to the module its frame runs,
 * and everything frames load (React, the kit, learning) is built into one script. The host never imports a plugin.
 *
 * Packages may be linked from a sibling checkout, so this also dedupes React (and lucide), lets the dev server read
 * those checkouts, and replaces `@gestalts-sources;` in the app's CSS with an `@source` per package and plugin
 * (Tailwind doesn't reliably scan through pnpm's symlinks). List it before `tailwindcss()`.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { compile } from '@gestalts/view/compile';
import { build, searchForWorkspaceRoot, type Plugin, type PluginOption, type Rollup } from 'vite';
import { parse } from 'yaml';
// by its package path: Node loads this file as it is when Vite reads the app's config, and needs no extension so
import { grantsFor } from '@gestalts/vite/grants';

const VIRTUAL = 'virtual:gestalts-plugins';
const RESOLVED = '\0' + VIRTUAL;
const SOURCES = /^@gestalts-sources;$/m;

type Manifest = { id: string; title: string; version: string; requires?: string[]; permissions?: string[] };
type DistributionFile = { id?: unknown; core?: string[]; plugins?: string[]; default_views?: string[]; install_ui?: boolean; grants?: unknown };
const DISTRIBUTION_KEYS = ['id', 'core', 'plugins', 'default_views', 'install_ui', 'grants'];
type PackageJson = { dependencies?: Record<string, string> };

function dependencies(root: string): string[] {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson;
  return Object.keys(pkg.dependencies ?? {});
}

function packageRoot(root: string, name: string): string {
  const link = join(root, 'node_modules', name);
  if (!existsSync(link)) throw new Error(`${name} is not installed in ${root}; run \`mise run setup\``);
  return realpathSync(link);
}

/** The real folders of the app's `@gestalts*` packages, and theirs in turn. */
function gestaltsPackages(appRoot: string): string[] {
  const found = new Set<string>();
  const visit = (root: string) => {
    for (const name of dependencies(root).filter((d) => d.startsWith('@gestalts'))) {
      const dir = packageRoot(root, name);
      if (!found.has(dir)) { found.add(dir); visit(dir); }
    }
  };
  visit(appRoot);
  return [...found];
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

function readGestalts(root: string): string[] {
  const dir = join(root, 'gestalts');
  return existsSync(dir) ? files(dir).filter((f) => f.endsWith('.yml')).sort().map((f) => readFileSync(f, 'utf8')) : [];
}

/**
 * Every yml of a published deck as one file, `[{id, text}]`, in its `index.json`'s order: the app reads a deck in one
 * download instead of one per yml. Made from the deck as it is, so it's never out of date or committed.
 */
function deckBundle(dir: string): string {
  const { ymls } = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { ymls: string[] };
  return JSON.stringify(ymls.flatMap((id) => {
    const f = join(dir, 'notes', `${id}.yml`);
    return existsSync(f) ? [{ id, text: readFileSync(f, 'utf8') }] : [];
  }));
}

/** The decks in a plugin's `decks/`; each is titled by the `deck` yml in it. */
function readDecks(pluginId: string, root: string) {
  const dir = join(root, 'decks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((id) => statSync(join(dir, id)).isDirectory()).map((id) => {
    const deck = join(dir, id);
    if (!existsSync(join(deck, 'index.json'))) throw new Error(`${pluginId}: its deck ${id} has no index.json; run \`mise run publish-data ${relative(process.cwd(), deck)}\``);
    const ymls = readdirSync(join(deck, 'notes')).map((f) => parse(readFileSync(join(deck, 'notes', f), 'utf8')) as { gestalt?: string; title?: string; name?: string });
    const meta = ymls.find((y) => y.gestalt === 'deck@1');
    if (!meta) throw new Error(`${pluginId}: its deck ${id} has no deck@1 yml`);
    return { id, title: meta.title ?? meta.name ?? id, dir: deck };
  });
}

function loadPlugin(appRoot: string, path: string, core: boolean) {
  const root = realpathSync(resolve(appRoot, path));
  const manifest = parse(readFileSync(join(root, 'plugin.yml'), 'utf8')) as Manifest;
  const viewFile = join(root, 'view.tsx');
  const compiled = compile(readFileSync(viewFile, 'utf8'), viewFile);
  if (!compiled.ok) throw new Error(`${manifest.id}/view.tsx: ${compiled.errors.map((e) => `${e.line ?? '?'}: ${e.message}`).join('; ')}`);
  return { id: manifest.id, root, manifest, gestalts: readGestalts(root), decks: readDecks(manifest.id, root), js: compiled.js, npm: compiled.npm, core, backend: existsSync(join(root, 'backend.py')) };
}

function load(appRoot: string) {
  const file = parse(readFileSync(join(appRoot, 'distribution.yml'), 'utf8')) as DistributionFile;
  const unknown = Object.keys(file).filter((k) => !DISTRIBUTION_KEYS.includes(k));
  if (unknown.length) throw new Error(`distribution.yml: unknown key ${unknown.join(', ')} (known: ${DISTRIBUTION_KEYS.join(', ')})`);
  if (typeof file.id !== 'string' || !/^[a-z0-9-]+$/.test(file.id)) throw new Error('distribution.yml needs an `id` (lowercase letters, digits and -)');
  const plugins = [...(file.core ?? []).map((p) => loadPlugin(appRoot, p, true)), ...(file.plugins ?? []).map((p) => loadPlugin(appRoot, p, false))];
  const seen = new Set<string>();
  for (const p of plugins) {
    if (seen.has(p.id)) throw new Error(`plugin ${p.id} is listed twice`);
    seen.add(p.id);
  }
  for (const v of file.default_views ?? []) if (!seen.has(v)) throw new Error(`default view ${v} is in no plugin of the distribution`);
  const granted = grantsFor(file.grants, plugins.map((p) => ({ id: p.id, permissions: p.manifest.permissions, npm: p.npm })));
  return {
    distribution: { id: file.id, default_views: file.default_views ?? [], install_ui: file.install_ui ?? false },
    plugins: plugins.map((p) => ({ ...p, granted: granted.get(p.id) ?? [] })),
  };
}

/** Everything a frame loads, as one script and its styles. */
async function buildRuntime(appRoot: string): Promise<{ js: string; css: string }> {
  const host = gestaltsPackages(appRoot).find((d) => /[\\/]host$/.test(d));
  if (!host) throw new Error('the app has no @gestalts/host');
  const result = await build({
    configFile: false,
    logLevel: 'warn',
    root: host,
    // always, also under the dev server: its development JSX needs a development React, and this bundles the production one
    mode: 'production',
    oxc: { jsx: { runtime: 'automatic', development: false } },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    resolve: { dedupe: ['react', 'react-dom', 'lucide-react'] },
    build: {
      write: false,
      minify: true,
      assetsInlineLimit: 100_000_000,
      chunkSizeWarningLimit: 100_000,
      lib: { entry: join(host, 'src/frame/runtime.tsx'), formats: ['iife'], name: '__gestaltsRuntimeBundle', fileName: () => 'runtime.js' },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result as Rollup.RollupOutput]).flatMap((r) => r.output);
  const js = outputs.flatMap((o) => (o.type === 'chunk' ? [o.code] : [])).join('\n');
  const css = outputs.flatMap((o) => (o.type === 'asset' && o.fileName.endsWith('.css') ? [String(o.source)] : [])).join('\n');
  return { js, css };
}

export function gestaltsPlugins(): PluginOption[] {
  let appRoot = process.cwd();
  let runtime: Promise<{ js: string; css: string }> | undefined;
  const sources: Plugin = {
    name: 'gestalts-sources',
    enforce: 'pre',
    configResolved(config) {
      const names = config.plugins.map((p) => p.name);
      const tailwind = names.findIndex((n) => n.startsWith('@tailwindcss/vite'));
      if (tailwind !== -1 && tailwind < names.indexOf('gestalts-sources')) throw new Error('list gestaltsPlugins() before tailwindcss() in vite.config.ts');
    },
    transform(code, id) {
      if (!/\.css(\?|$)/.test(id) || !SOURCES.test(code)) return;
      const dirs = [...gestaltsPackages(appRoot).map((d) => join(d, 'src')).filter((d) => existsSync(d)), ...load(appRoot).plugins.map((p) => join(p.root, 'view.tsx'))];
      return code.replace(SOURCES, dirs.map((d) => `@source ${JSON.stringify(d)};`).join('\n'));
    },
  };
  const registry: Plugin = {
    name: 'gestalts-plugins',
    config(config) {
      const root = resolve(config.root ?? process.cwd());
      const allow = [...new Set([root, ...gestaltsPackages(root)].map((dir) => searchForWorkspaceRoot(dir)))];
      // the core runs in a module worker (`@gestalts/client`'s core.worker.ts), which imports the wasm
      return { resolve: { dedupe: ['react', 'react-dom', 'lucide-react'] }, server: { fs: { allow } }, worker: { format: 'es' } };
    },
    configResolved(config) { appRoot = config.root; },
    resolveId(id) { return id === VIRTUAL ? RESOLVED : undefined; },
    async load(id) {
      if (id !== RESOLVED) return;
      const { distribution, plugins } = load(appRoot);
      this.addWatchFile(join(appRoot, 'distribution.yml'));
      runtime ??= buildRuntime(appRoot);
      const entries = plugins.map((p) => {
        this.addWatchFile(join(p.root, 'plugin.yml'));
        this.addWatchFile(join(p.root, 'view.tsx'));
        const decks = p.decks.map((d) => ({ id: d.id, title: d.title, source: `${p.id}/${d.id}`, path: `decks/${p.id}/${d.id}` }));
        return { manifest: p.manifest, gestalts: p.gestalts, decks, js: p.js, npm: p.npm, core: p.core, granted: p.granted, backend: p.backend };
      });
      return `export const registry = ${JSON.stringify({ distribution, plugins: entries, runtime: await runtime })};\n`;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/decks\/([a-z0-9.-]+)\/([a-z0-9.-]+)\/(.+)$/.exec((req.url ?? '').split('?')[0]);
        if (!m) return next();
        const d = load(appRoot).plugins.find((x) => x.id === m[1])?.decks.find((x) => x.id === m[2]);
        if (d && m[3] === 'ymls.json') { res.setHeader('content-type', 'application/json'); res.end(deckBundle(d.dir)); return; }
        const file = d && resolve(d.dir, decodeURIComponent(m[3]));
        if (!d || !file || !file.startsWith(d.dir + '/') || !existsSync(file)) { res.statusCode = 404; res.end(); return; }
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const p of load(appRoot).plugins) {
        for (const d of p.decks) {
          for (const f of files(d.dir)) {
            this.emitFile({ type: 'asset', fileName: `decks/${p.id}/${d.id}/${relative(d.dir, f)}`, source: readFileSync(f) });
          }
          this.emitFile({ type: 'asset', fileName: `decks/${p.id}/${d.id}/ymls.json`, source: deckBundle(d.dir) });
        }
      }
    },
  };
  return [sources, registry];
}
