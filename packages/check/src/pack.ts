/**
 * What `scripts/pack.ts` records into `pack/` and the checks read back: the files TypeScript needs (`TypePack`) and
 * @gestalts/viz's runtime sources (`VizRuntime`), by their path in the checkout with its root as `/r`.
 */

export type TypePack = {
  /** where the checked file sits: the draft's `view.tsx` (or `viz.ts`) takes its place */
  entry: string;
  /** the other files every check starts from (e.g. what a viz may import besides code) */
  roots: string[];
  /** the default lib's path */
  lib: string;
  files: Record<string, string>;
  /** symlinks TypeScript followed: path -> real path */
  realpaths: Record<string, string>;
};

export type VizRuntime = {
  files: Record<string, string>;
  /** fonts and images, as base64 */
  binary: Record<string, string>;
  /** `<importer>\0<specifier>` -> the file it resolved to; the importer is '' for the entry */
  resolved: Record<string, string>;
};

/** The agent template's tsconfig, for a view. */
export const VIEW_TSCONFIG = {
  target: 'ES2023', lib: ['ES2024', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'bundler', jsx: 'react-jsx',
  strict: true, noFallthroughCasesInSwitch: true, skipLibCheck: true, noEmit: true, types: ['vite/client'],
};

/** A viz's. */
export const VIZ_TSCONFIG = {
  target: 'ES2023', lib: ['ES2024', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'bundler', strict: true,
  noEmit: true, skipLibCheck: true, verbatimModuleSyntax: true, allowImportingTsExtensions: true, types: [],
};
