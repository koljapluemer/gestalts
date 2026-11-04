/**
 * The plugins an app is built with, as the virtual module `virtual:gestalts-plugins`: each plugin's manifest, its
 * gestalts (YAML text), its deck (served under `decks/<id>/`) and loaders for its UI modules. The plugins are the
 * app's `@gestalts-plugin/*` dependencies in its `package.json`; `distribution.yml` next to it names the distribution
 * (`id`) and says which panes it opens with. The host loads plugins through this registry and never imports them, so an app builds with any list,
 * even an empty one.
 *
 * The packages may be linked from a sibling checkout (`link:../gestalts/...`), so this also dedupes React (and lucide), lets the
 * dev server read those checkouts, and replaces `@gestalts-sources;` in the app's CSS with an `@source` per package
 * (Tailwind doesn't reliably scan through pnpm's symlinks). List it before `tailwindcss()`.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { searchForWorkspaceRoot, type Plugin, type PluginOption } from 'vite';
import { parse } from 'yaml';

const VIRTUAL = 'virtual:gestalts-plugins';
const RESOLVED = '\0' + VIRTUAL;
const PLUGIN_SCOPE = '@gestalts-plugin/';
const SOURCES = /^@gestalts-sources;$/m;

type Manifest = {
  id: string;
  host_api: number;
  gestalts?: string[];
  deck?: { path: string; aliases?: string[] };
  panes?: { id: string; title: string; entry: string; requires?: { services?: string[] } }[];
  slots?: { slot: string; gestalt: string; entry: string }[];
};

type Distribution = { id?: unknown; default_panes?: string[]; install_ui?: boolean };

type PackageJson = { dependencies?: Record<string, string> };

function dependencies(root: string): string[] {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson;
  return Object.keys(pkg.dependencies ?? {});
}

/** Where a dependency of a package really is: pnpm links each one into the package's `node_modules`. */
function packageRoot(root: string, name: string): string {
  const link = join(root, 'node_modules', name);
  if (!existsSync(link)) throw new Error(`${name} is not installed in ${root}; run \`mise run setup\``);
  return realpathSync(link);
}

/** The real folders of the app's `@gestalts*` packages, and theirs in turn (the kit comes in through the host). */
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

function load(appRoot: string) {
  const distribution = parse(readFileSync(join(appRoot, 'distribution.yml'), 'utf8')) as Distribution;
  // pane notes record it, so a distribution keeps its id for good
  if (typeof distribution.id !== 'string' || !/^[a-z0-9-]+$/.test(distribution.id)) throw new Error('distribution.yml needs an `id` (lowercase letters, digits and -)');
  const ids = dependencies(appRoot).filter((d) => d.startsWith(PLUGIN_SCOPE)).map((d) => d.slice(PLUGIN_SCOPE.length));
  const plugins = ids.map((id) => {
    const root = packageRoot(appRoot, PLUGIN_SCOPE + id);
    const manifest = parse(readFileSync(join(root, 'plugin.yml'), 'utf8')) as Manifest;
    if (manifest.id !== id) throw new Error(`${PLUGIN_SCOPE}${id}'s plugin.yml has id ${manifest.id}`);
    if (manifest.host_api !== 1) throw new Error(`${id} needs host API ${manifest.host_api}; this host offers 1`);
    const gestalts = (manifest.gestalts ?? []).map((g) => {
      const [name, version] = g.split('@');
      return readFileSync(join(root, 'gestalts', name, `v${version}.yml`), 'utf8');
    });
    const deckDir = manifest.deck ? join(root, manifest.deck.path) : null;
    if (deckDir && !existsSync(join(deckDir, 'index.json'))) throw new Error(`${id}: its deck has no index.json; run \`mise run publish-data ${relative(process.cwd(), deckDir)}\``);
    const modules = [...new Set([...(manifest.panes ?? []), ...(manifest.slots ?? [])].map((e) => e.entry.split('#')[0]))];
    return { id, root, manifest, gestalts, deckDir, modules };
  });
  for (const ref of distribution.default_panes ?? []) {
    const [plugin, pane] = ref.split('/');
    if (!plugins.some((p) => p.id === plugin && p.manifest.panes?.some((q) => q.id === pane))) throw new Error(`default pane ${ref} is in no plugin of the distribution`);
  }
  return { distribution: { ...distribution, plugins: ids }, plugins };
}

export function gestaltsPlugins(): PluginOption[] {
  let appRoot = process.cwd();
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
      const dirs = gestaltsPackages(appRoot).flatMap((d) => ['src', 'ui/src'].map((s) => join(d, s))).filter((d) => existsSync(d));
      return code.replace(SOURCES, dirs.map((d) => `@source ${JSON.stringify(d)};`).join('\n'));
    },
  };
  const registry: Plugin = {
    name: 'gestalts-plugins',
    config(config) {
      // a package linked from another checkout brings its own copies of React and lucide; the app must have one each
      const root = resolve(config.root ?? process.cwd());
      const allow = [...new Set([root, ...gestaltsPackages(root)].map((dir) => searchForWorkspaceRoot(dir)))];
      return { resolve: { dedupe: ['react', 'react-dom', 'lucide-react'] }, server: { fs: { allow } } };
    },
    configResolved(config) { appRoot = config.root; },
    resolveId(id) { return id === VIRTUAL ? RESOLVED : undefined; },
    load(id) {
      if (id !== RESOLVED) return;
      const { distribution, plugins } = load(appRoot);
      this.addWatchFile(join(appRoot, 'distribution.yml'));
      this.addWatchFile(join(appRoot, 'package.json'));
      const entries = plugins.map((p) => {
        this.addWatchFile(join(p.root, 'plugin.yml'));
        const modules = p.modules.map((m) => `${JSON.stringify(m)}: () => import(${JSON.stringify(join(p.root, m))})`).join(', ');
        const deck = p.deckDir ? { source: p.id, aliases: p.manifest.deck?.aliases ?? [], path: `decks/${p.id}` } : null;
        return `{ manifest: ${JSON.stringify(p.manifest)}, gestalts: ${JSON.stringify(p.gestalts)}, deck: ${JSON.stringify(deck)}, modules: { ${modules} } }`;
      });
      return `export const distribution = ${JSON.stringify({ default_panes: [], install_ui: false, ...distribution })};\nexport const plugins = [${entries.join(',\n')}];\n`;
    },
    configureServer(server) {
      // decks in development: /decks/<id>/… from plugins/<id>/<deck path>
      server.middlewares.use((req, res, next) => {
        const m = /^\/decks\/([a-z0-9-]+)\/(.+)$/.exec((req.url ?? '').split('?')[0]);
        if (!m) return next();
        const p = load(appRoot).plugins.find((x) => x.id === m[1]);
        const file = p?.deckDir && resolve(p.deckDir, decodeURIComponent(m[2]));
        if (!file || !file.startsWith(p.deckDir + '/') || !existsSync(file)) { res.statusCode = 404; res.end(); return; }
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const p of load(appRoot).plugins) {
        if (!p.deckDir) continue;
        for (const f of files(p.deckDir)) {
          this.emitFile({ type: 'asset', fileName: `decks/${p.id}/${relative(p.deckDir, f)}`, source: readFileSync(f) });
        }
      }
    },
  };
  return [sources, registry];
}
