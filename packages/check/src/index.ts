/**
 * @gestalts/check: what a draft view (`checkView`) or a viz (`checkViz`) is checked with, by whatever agent made it
 * and by the app itself. The same code in the page (`@gestalts/check/browser`) and in Node (`@gestalts/check/node`);
 * only the platform differs: where TypeScript runs, how images decode, where a viz's code runs.
 */
import type { Pixels } from '@gestalts/viz/page';
import type { VizRuntime } from './pack.ts';

export { checkView, type ViewContext } from './view.ts';
export { checkViz, packagesOf } from './viz.ts';
export type { Pixels };

/** A draft's files by path: text, or bytes for a viz's `files/`. */
export type Files = Record<string, string | Uint8Array>;

export type CheckItem = { ok: boolean; name: string; message?: string };

export type Shot = { name: string; png: Uint8Array };

export type CheckResult = {
  ok: boolean;
  /** what an agent reads: one line per item, the failures with their details */
  report: string;
  items: CheckItem[];
  /** screenshots, for an agent that can look */
  shots: Shot[];
  /** a viz's built page and its still, when everything passed */
  built?: string;
  still?: Uint8Array;
};

/** One result of a viz's own `checks`. */
export type VizCheck = { name: string; ok: boolean; message?: string };

export type Render = { problems: string[]; shots: Shot[]; still?: Uint8Array };

export interface Platform {
  /** esbuild (esbuild-wasm), initialized */
  build(options: import('esbuild-wasm').BuildOptions): Promise<import('esbuild-wasm').BuildResult>;
  /** TypeScript's errors in `files` (`view.tsx`, or `viz.ts`), as `file:line:col message`, less those `ignore` says */
  typecheck(kind: 'view' | 'viz', files: Record<string, string>, ignore: (message: string) => boolean): Promise<string[]>;
  decodeImage(name: string, bytes: Uint8Array): Promise<Pixels>;
  /** runs an ES module exporting `results` (a viz's checks) where it can't reach anything */
  runChecks(js: string): Promise<VizCheck[]>;
  /** renders a built page at several sizes; absent where there is no browser */
  render?(html: string): Promise<Render>;
  vizRuntime(): Promise<VizRuntime>;
}

export function result(items: CheckItem[], extra: Partial<CheckResult> = {}): CheckResult {
  const ok = items.every((i) => i.ok);
  const lines = items.map((i) => (i.ok ? `✓ ${i.name}` : `✗ ${i.name}${i.message ? `\n${i.message.trim().replace(/^/gm, '    ')}` : ''}`));
  lines.push(ok ? '✓ all good' : '✗ not yet: fix the above and check again');
  return { ok, report: lines.join('\n'), items, shots: [], ...extra };
}

/** `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`. */
export const packageName = (spec: string) => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');
