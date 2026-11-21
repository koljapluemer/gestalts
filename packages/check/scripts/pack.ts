// `node scripts/pack.ts` (part of `mise run setup`): what the checks need besides their code, recorded from this
// checkout into `pack/`, so they run the same in the page (no file system) and in Node:
//
// - `view-types.json`, `viz-types.json`: every file TypeScript reads to typecheck a view (or a viz) against what the
//   frame provides: the lib, @types/react, lucide-react, the @gestalts packages' sources, with the symlinks it followed
// - `viz-runtime.json`: @gestalts/viz's runtime sources and what they import (temml), with how each import resolved,
//   for esbuild to bundle a page from
//
// Paths are the checkout's with its root as `/r`, so they're the same on every machine.
import { build, type Plugin } from 'esbuild';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import ts from 'typescript-js';
import { RUNTIME_MODULES } from '@gestalts/view/compile';
import { LOADERS } from '@gestalts/viz/page';
import { VIEW_TSCONFIG, VIZ_TSCONFIG, type TypePack, type VizRuntime } from '../src/pack.ts';

const here = resolve(import.meta.dirname, '..');
const root = resolve(here, '../..');
const out = join(here, 'pack');
const virtual = (p: string) => (p.startsWith(`${root}/`) ? `/r/${p.slice(root.length + 1)}` : p === root ? '/r' : (() => { throw new Error(`outside the checkout: ${p}`); })());

/** Records every file TypeScript reads typechecking `entry` (`text`) with `options`. */
function typePack(name: 'view' | 'viz', file: string, text: string, tsconfig: object, roots: string[] = []): TypePack {
  const entry = join(here, '.probe', name, file);
  const options = ts.convertCompilerOptionsFromJson(tsconfig, dirname(entry)).options;
  const files: Record<string, string> = {};
  const realpaths: Record<string, string> = {};
  const read = (p: string) => {
    if (p === entry) return text;
    const t = ts.sys.readFile(p);
    if (t !== undefined) files[virtual(p)] = t;
    return t;
  };
  const host: ts.CompilerHost = {
    getSourceFile: (f, lang) => { const t = read(f); return t === undefined ? undefined : ts.createSourceFile(f, t, lang); },
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    writeFile: () => {},
    getCurrentDirectory: () => dirname(entry),
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (f) => f === entry || ts.sys.fileExists(f),
    readFile: read,
    directoryExists: (d) => ts.sys.directoryExists(d),
    getDirectories: (d) => ts.sys.getDirectories(d),
    realpath: (p) => {
      const r = realpathSync.native(p);
      if (r !== p) realpaths[virtual(p)] = virtual(r);
      return r;
    },
  };
  const program = ts.createProgram([entry, ...roots], options, host);
  const problems = ts.getPreEmitDiagnostics(program, program.getSourceFile(entry));
  if (problems.length) throw new Error(`the ${name} probe doesn't typecheck:\n${ts.formatDiagnostics(problems, host)}`);
  // what the program holds, also when it came from a cache
  for (const sf of program.getSourceFiles()) if (sf.fileName !== entry) files[virtual(sf.fileName)] ??= sf.text;
  return { entry: virtual(entry), roots: roots.map(virtual), lib: virtual(ts.getDefaultLibFilePath(options)), files, realpaths };
}

/** Bundles every runtime entry once, recording each file esbuild loads and how each import of them resolved. */
async function vizRuntime(): Promise<VizRuntime> {
  const files: Record<string, string> = {};
  const binary: Record<string, string> = {};
  const resolved: Record<string, string> = {};
  const record: Plugin = {
    name: 'record',
    setup(b) {
      b.onResolve({ filter: /.*/ }, async (a) => {
        if (a.pluginData === 'recording' || a.kind === 'entry-point') return undefined;
        const r = await b.resolve(a.path, { kind: a.kind, importer: a.importer, resolveDir: a.resolveDir, pluginData: 'recording' });
        if (r.errors.length) return { errors: r.errors };
        if (r.namespace !== 'file') return r;
        const importer = a.importer === '<stdin>' ? '' : virtual(a.importer);
        resolved[`${importer}\0${a.path}`] = virtual(r.path);
        const ext = extname(r.path);
        if ((LOADERS as Record<string, string>)[ext] === 'dataurl') binary[virtual(r.path)] = readFileSync(r.path).toString('base64');
        else files[virtual(r.path)] = readFileSync(r.path, 'utf8');
        return r;
      });
    },
  };
  await build({
    stdin: { contents: "import '@gestalts/viz';\nimport '@gestalts/viz/mount';\nimport '@gestalts/viz/tex';\n", resolveDir: here, loader: 'ts' },
    bundle: true, write: false, outdir: join(here, '.probe/out'), logLevel: 'silent', plugins: [record], loader: { ...LOADERS },
  });
  return { files, binary, resolved };
}

const ENTRIES = RUNTIME_MODULES.map((m, i) => `import * as m${i} from '${m}';`).join('\n');
const view = typePack('view', 'view.tsx', `${ENTRIES}\nexport default [${RUNTIME_MODULES.map((_, i) => `m${i}`).join(', ')}];\n`, VIEW_TSCONFIG);
const viz = typePack('viz', 'viz.ts', "import * as a from '@gestalts/viz';\nimport * as b from '@gestalts/viz/tex';\nimport p from './files/x.png?pixels';\nexport default [a, b, p];\n",
  VIZ_TSCONFIG, [join(root, 'packages/viz/client.d.ts')]);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'view-types.json'), JSON.stringify(view));
writeFileSync(join(out, 'viz-types.json'), JSON.stringify(viz));
writeFileSync(join(out, 'viz-runtime.json'), JSON.stringify(await vizRuntime()));
const size = (p: string) => `${Math.round(readFileSync(join(out, p)).length / 1024)} KB`;
console.log(`pack/: view types ${size('view-types.json')}, viz types ${size('viz-types.json')}, viz runtime ${size('viz-runtime.json')}`);
