/**
 * What an app builds with, as the virtual module `virtual:gestalts-plugins`. `distribution.yml` next to the app names
 * the distribution and lists its plugins and model packages (the gestalts beyond the core's), as folders. An app with
 * several (one per area) has `distributions/<name>.yml` instead, each as `virtual:gestalts-plugins/<name>`. Each
 * plugin's `view.tsx` is compiled to the module its frame runs, and everything frames load (React, the kit, learning)
 * is built into one script, shared by all of an app's distributions. The host never imports a plugin.
 *
 * Packages may be linked from a sibling checkout, so this also dedupes React (and lucide), lets the dev server read
 * those checkouts, and replaces `@gestalts-sources;` in the app's CSS with an `@source` per package and plugin
 * (Tailwind doesn't reliably scan through pnpm's symlinks). List it before `tailwindcss()`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { compile } from '@gestalts/view/compile';
import { build, searchForWorkspaceRoot, type Plugin, type PluginOption, type Rollup } from 'vite';
import { parse } from 'yaml';
// by its package path: Node loads this file as it is when Vite reads the app's config, and needs no extension so
import { grantsFor } from '@gestalts/vite/grants';

const VIRTUAL = 'virtual:gestalts-plugins';
const RESOLVED = '\0' + VIRTUAL;
const DISTRIBUTIONS = 'distributions';
/** the frame runtime, once for all of an app's registries */
const RUNTIME = 'virtual:gestalts-runtime';
const SOURCES = /^@gestalts-sources;$/m;

type Manifest = { id: string; title: string; version: string; reads?: string[]; requires?: string[]; permissions?: string[] };
type DistributionFile = { id?: unknown; core?: string[]; plugins?: string[]; models?: string[]; default_views?: string[]; install_ui?: boolean; grants?: unknown };
const DISTRIBUTION_KEYS = ['id', 'core', 'plugins', 'models', 'default_views', 'install_ui', 'grants'];
/** The repo's `gestalts/`: the core's (`<name>/v<N>.yml`, compiled in) and the model packages (`<package>/<name>/`). */
const GESTALTS = resolve(import.meta.dirname, '../../../gestalts');
type PackageJson = { dependencies?: Record<string, string> };

function dependencies(root: string): string[] {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson;
  return Object.keys(pkg.dependencies ?? {});
}

function packageRoot(root: string, name: string): string {
  const link = join(root, 'node_modules', name);
  if (!existsSync(link)) throw new Error(`${name} is not installed in ${root}; run \`mise run just setup\``);
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

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
const definitionsIn = (dir: string) => readdirSync(dir).filter((f) => /^v\d+\.yml$/.test(f)).sort().map((f) => join(dir, f));
const subdirs = (dir: string) => readdirSync(dir).map((n) => join(dir, n)).filter(isDir).sort();
/** A folder of gestalt folders, not one of the core's (which holds `v<N>.yml`). */
const isPackage = (dir: string) => isDir(dir) && !definitionsIn(dir).length && subdirs(dir).some((g) => definitionsIn(g).length > 0);
const gestaltId = (text: string) => { const d = parse(text) as { name: string; version: number }; return `${d.name}@${d.version}`; };

/** A model package's definitions, as YAML, and the gestalts they define. */
function loadModel(base: string, path: string, where: string) {
  const root = realpathSync(resolve(base, path));
  if (!isPackage(root)) throw new Error(`${where}: model ${path} is not a package (gestalts/<package>/<name>/v<N>.yml)`);
  const texts = subdirs(root).flatMap(definitionsIn).map((f) => readFileSync(f, 'utf8'));
  return { root, texts, ids: texts.map(gestaltId) };
}

/** The core's gestalts, compiled in: every `gestalts/<name>/v<N>.yml`. */
function coreGestalts(): Set<string> {
  if (!isDir(GESTALTS)) return new Set();
  return new Set(subdirs(GESTALTS).filter((d) => !isPackage(d)).flatMap(definitionsIn).map((f) => gestaltId(readFileSync(f, 'utf8'))));
}

/** The repo's package defining `id`, to say what to add. */
function packageOf(id: string): string | undefined {
  if (!isDir(GESTALTS)) return undefined;
  return subdirs(GESTALTS).filter(isPackage).find((p) => subdirs(p).flatMap(definitionsIn).some((f) => gestaltId(readFileSync(f, 'utf8')) === id));
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
    const meta = ymls.find((y) => y.gestalt === 'deck@1' || y.gestalt === 'deck@2');
    if (!meta) throw new Error(`${pluginId}: its deck ${id} has no deck yml`);
    const gestalts = [...new Set(ymls.flatMap((y) => (typeof y.gestalt === 'string' ? [y.gestalt] : [])))];
    return { id, title: meta.title ?? meta.name ?? id, dir: deck, gestalts };
  });
}

function loadPlugin(base: string, path: string, core: boolean) {
  const root = realpathSync(resolve(base, path));
  const manifest = parse(readFileSync(join(root, 'plugin.yml'), 'utf8')) as Manifest;
  const viewFile = join(root, 'view.tsx');
  const compiled = compile(readFileSync(viewFile, 'utf8'), viewFile);
  if (!compiled.ok) throw new Error(`${manifest.id}/view.tsx: ${compiled.errors.map((e) => `${e.line ?? '?'}: ${e.message}`).join('; ')}`);
  if (existsSync(join(root, 'gestalts'))) throw new Error(`${manifest.id}: a plugin doesn't define gestalts; they go in a model package, gestalts/<package>/<name>/v<N>.yml`);
  return { id: manifest.id, root, manifest, decks: readDecks(manifest.id, root), js: compiled.js, npm: compiled.npm, core, backend: existsSync(join(root, 'backend.py')) };
}

/**
 * The app's distributions, by the name its virtual module has: `''` for `distribution.yml` (`virtual:gestalts-plugins`),
 * `<name>` for each `distributions/<name>.yml` (`virtual:gestalts-plugins/<name>`).
 */
export function distributionFiles(appRoot: string): Map<string, string> {
  const single = join(appRoot, 'distribution.yml');
  const dir = join(appRoot, DISTRIBUTIONS);
  if (existsSync(single) && isDir(dir)) throw new Error(`${appRoot} has both distribution.yml and ${DISTRIBUTIONS}/: one or the other`);
  if (existsSync(single)) return new Map([['', single]]);
  if (!isDir(dir)) throw new Error(`${appRoot} has no distribution.yml (nor ${DISTRIBUTIONS}/<name>.yml)`);
  const names = readdirSync(dir).filter((f) => f.endsWith('.yml')).sort();
  for (const f of names) if (!/^[a-z0-9-]+\.yml$/.test(f)) throw new Error(`${DISTRIBUTIONS}/${f}: name it with lowercase letters, digits and -`);
  return new Map(names.map((f) => [f.slice(0, -'.yml'.length), join(dir, f)]));
}

/** One distribution, from its file; paths in it are from that file. */
export function loadDistribution(file: string) {
  const base = dirname(file);
  const where = basename(base) === DISTRIBUTIONS ? `${DISTRIBUTIONS}/${basename(file)}` : basename(file);
  const parsed = parse(readFileSync(file, 'utf8')) as DistributionFile;
  const unknown = Object.keys(parsed).filter((k) => !DISTRIBUTION_KEYS.includes(k));
  if (unknown.length) throw new Error(`${where}: unknown key ${unknown.join(', ')} (known: ${DISTRIBUTION_KEYS.join(', ')})`);
  if (typeof parsed.id !== 'string' || !/^[a-z0-9-]+$/.test(parsed.id)) throw new Error(`${where} needs an \`id\` (lowercase letters, digits and -)`);
  const plugins = [...(parsed.core ?? []).map((p) => loadPlugin(base, p, true)), ...(parsed.plugins ?? []).map((p) => loadPlugin(base, p, false))];
  const seen = new Set<string>();
  for (const p of plugins) {
    if (seen.has(p.id)) throw new Error(`${where}: plugin ${p.id} is listed twice`);
    seen.add(p.id);
  }
  for (const v of parsed.default_views ?? []) if (!seen.has(v)) throw new Error(`${where}: default view ${v} is in no plugin of the distribution`);
  const models = (parsed.models ?? []).map((m) => loadModel(base, m, where));
  // every gestalt a view reads or a deck holds is the core's or a named model's
  const defined = new Set([...coreGestalts(), ...models.flatMap((m) => m.ids)]);
  for (const p of plugins) {
    const used = [...(p.manifest.reads ?? []).map((g) => [g, 'reads'] as const), ...p.decks.flatMap((d) => d.gestalts.map((g) => [g, `its deck ${d.id} holds`] as const))];
    for (const [g, how] of used) {
      if (defined.has(g)) continue;
      const pkg = packageOf(g);
      throw new Error(`${where}: ${p.id} ${how} ${g}, which ${pkg ? `package ${relative(base, pkg)} defines: add it to \`models\`` : 'nothing defines'}`);
    }
  }
  const granted = grantsFor(parsed.grants, plugins.map((p) => ({ id: p.id, permissions: p.manifest.permissions, npm: p.npm })));
  return {
    file,
    distribution: { id: parsed.id, default_views: parsed.default_views ?? [], install_ui: parsed.install_ui ?? false },
    plugins: plugins.map((p) => ({ ...p, granted: granted.get(p.id) ?? [] })),
    models,
  };
}

type Loaded = ReturnType<typeof loadDistribution>;

/**
 * Every distribution of the app, by name. Distributions may share a plugin (the same folder), whose decks are then
 * served once; two different plugins with one id would serve each other's decks, so they're refused.
 */
export function loadApp(appRoot: string): Map<string, Loaded> {
  const loaded = new Map([...distributionFiles(appRoot)].map(([name, file]) => [name, loadDistribution(file)] as const));
  const ids = new Set<string>();
  const roots = new Map<string, string>();
  for (const [name, d] of loaded) {
    if (ids.has(d.distribution.id)) throw new Error(`${DISTRIBUTIONS}/${name}.yml: id ${d.distribution.id} is another distribution's too`);
    ids.add(d.distribution.id);
    for (const p of d.plugins) {
      const other = roots.get(p.id);
      if (other !== undefined && other !== p.root) throw new Error(`plugin id ${p.id} is two plugins: ${other} and ${p.root}`);
      roots.set(p.id, p.root);
    }
  }
  return loaded;
}

/** Each plugin of the app once, whichever distributions it is in. */
function appPlugins(appRoot: string): Loaded['plugins'] {
  const byId = new Map<string, Loaded['plugins'][number]>();
  for (const d of loadApp(appRoot).values()) for (const p of d.plugins) byId.set(p.id, p);
  return [...byId.values()];
}

/** Everything a frame loads, as one script and its styles. */
async function buildRuntime(appRoot: string): Promise<{ js: string; css: string; version: string }> {
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
  return { js, css, version: createHash('sha256').update(js).digest('hex').slice(0, 16) };
}

export function gestaltsPlugins(): PluginOption[] {
  let appRoot = process.cwd();
  let runtime: Promise<{ js: string; css: string; version: string }> | undefined;
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
      const dirs = [...gestaltsPackages(appRoot).map((d) => join(d, 'src')).filter((d) => existsSync(d)), ...appPlugins(appRoot).map((p) => join(p.root, 'view.tsx'))];
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
    resolveId(id) {
      if (id === RUNTIME) return `\0${RUNTIME}`;
      return id === VIRTUAL || id.startsWith(`${VIRTUAL}/`) ? `\0${id}` : undefined;
    },
    async load(id) {
      if (id === `\0${RUNTIME}`) {
        runtime ??= buildRuntime(appRoot);
        return `export const runtime = ${JSON.stringify(await runtime)};\n`;
      }
      if (id !== RESOLVED && !id.startsWith(`${RESOLVED}/`)) return;
      const name = id.slice(RESOLVED.length + 1);
      const files = distributionFiles(appRoot);
      const file = files.get(name);
      if (!file) throw new Error(`${id.slice(1)}: the app has no such distribution (it has ${[...files.keys()].map((n) => (n ? `${VIRTUAL}/${n}` : VIRTUAL)).join(', ')})`);
      loadApp(appRoot);
      const { distribution, plugins, models } = loadDistribution(file);
      this.addWatchFile(file);
      for (const m of models) for (const f of subdirs(m.root).flatMap(definitionsIn)) this.addWatchFile(f);
      const entries = plugins.map((p) => {
        this.addWatchFile(join(p.root, 'plugin.yml'));
        this.addWatchFile(join(p.root, 'view.tsx'));
        const decks = p.decks.map((d) => ({ id: d.id, title: d.title, source: `${p.id}/${d.id}`, path: `decks/${p.id}/${d.id}` }));
        return { manifest: p.manifest, decks, js: p.js, npm: p.npm, core: p.core, granted: p.granted, backend: p.backend };
      });
      const gestalts = models.flatMap((m) => m.texts);
      return `import { runtime } from ${JSON.stringify(RUNTIME)};\nexport const registry = { ...${JSON.stringify({ distribution, plugins: entries, gestalts })}, runtime };\n`;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/decks\/([a-z0-9.-]+)\/([a-z0-9.-]+)\/(.+)$/.exec((req.url ?? '').split('?')[0]);
        if (!m) return next();
        const d = appPlugins(appRoot).find((x) => x.id === m[1])?.decks.find((x) => x.id === m[2]);
        if (d && m[3] === 'ymls.json') { res.setHeader('content-type', 'application/json'); res.end(deckBundle(d.dir)); return; }
        const file = d && resolve(d.dir, decodeURIComponent(m[3]));
        if (!d || !file || !file.startsWith(d.dir + '/') || !existsSync(file)) { res.statusCode = 404; res.end(); return; }
        res.end(readFileSync(file));
      });
    },
    async generateBundle() {
      // the frame runtime this build carries, by version, for whatever serves builds by it (the lesson player)
      if (runtime) this.emitFile({ type: 'asset', fileName: 'gestalts-runtime.json', source: `${JSON.stringify({ version: (await runtime).version })}\n` });
      for (const p of appPlugins(appRoot)) {
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
