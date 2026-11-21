/**
 * TypeScript on a recorded pack (`pack.ts`): the draft's file takes the probe's place, everything else comes from the
 * pack, so no file system is needed. The pack's files are parsed once and kept; only the draft's change.
 */
import type tsModule from 'typescript-js';
import type { TypePack } from './pack.ts';
import { VIEW_TSCONFIG, VIZ_TSCONFIG } from './pack.ts';

type TS = typeof tsModule;

export class Checker {
  private readonly dirs = new Set<string>();
  private readonly cache = new Map<string, tsModule.SourceFile>();
  private readonly options: tsModule.CompilerOptions;
  private readonly base: string;
  private old?: tsModule.Program;
  private readonly ts: TS;
  private readonly pack: TypePack;

  constructor(ts: TS, pack: TypePack, kind: 'view' | 'viz') {
    this.ts = ts;
    this.pack = pack;
    this.base = pack.entry.slice(0, pack.entry.lastIndexOf('/'));
    this.options = ts.convertCompilerOptionsFromJson(kind === 'view' ? VIEW_TSCONFIG : VIZ_TSCONFIG, this.base).options;
    for (const f of [...Object.keys(pack.files), ...Object.values(pack.realpaths), ...Object.keys(pack.realpaths), pack.entry]) {
      for (let d = f.slice(0, f.lastIndexOf('/')); d && !this.dirs.has(d); d = d.slice(0, d.lastIndexOf('/'))) this.dirs.add(d);
    }
  }

  /** The errors in `files` (paths relative to the draft, the main one being the probe's name), as `file:line:col message`. */
  check(files: Record<string, string>): string[] {
    const { ts, pack, base } = this;
    const own = new Map(Object.entries(files).map(([p, t]) => [`${base}/${p}`, t]));
    // a symlinked path reads as what it links to
    const read = (p: string) => own.get(p) ?? pack.files[p] ?? pack.files[pack.realpaths[p] ?? ''];
    const host: tsModule.CompilerHost = {
      getSourceFile: (f, lang) => {
        const t = read(f);
        if (t === undefined) return undefined;
        if (own.has(f)) return ts.createSourceFile(f, t, lang, true);
        let sf = this.cache.get(f);
        if (!sf) { sf = ts.createSourceFile(f, t, lang, true); this.cache.set(f, sf); }
        return sf;
      },
      getDefaultLibFileName: () => pack.lib,
      getDefaultLibLocation: () => pack.lib.slice(0, pack.lib.lastIndexOf('/')),
      writeFile: () => {},
      getCurrentDirectory: () => base,
      getCanonicalFileName: (f) => f,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
      fileExists: (f) => read(f) !== undefined,
      readFile: read,
      directoryExists: (dir) => {
        const d = dir.replace(/\/+$/, '');
        return this.dirs.has(d) || [...own.keys()].some((f) => f.startsWith(`${d}/`));
      },
      getDirectories: () => [],
      realpath: (p) => pack.realpaths[p] ?? pack.realpaths[p.replace(/\/+$/, '')] ?? p,
    };
    const roots = [pack.entry, ...pack.roots];
    const program = ts.createProgram({ rootNames: roots, options: this.options, host, oldProgram: this.old });
    this.old = program;
    const out: string[] = [];
    for (const path of own.keys()) {
      const sf = program.getSourceFile(path);
      if (!sf) continue;
      for (const d of [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]) {
        const where = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : undefined;
        const name = path.slice(base.length + 1);
        out.push(`${name}${where ? `:${where.line + 1}:${where.character + 1}` : ''} - error TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
      }
    }
    return out;
  }
}
