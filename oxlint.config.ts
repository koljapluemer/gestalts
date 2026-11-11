import { defineConfig } from 'oxlint';

/**
 * Who may import whom (eslint-plugin-boundaries):
 * - `@gestalts/view` (what a view gets from the app) imports nothing of ours; `@gestalts/learning` only the view package;
 *   `@gestalts/sources` nothing of ours.
 * - `@gestalts/kit` imports only the view and sources packages, in layers: primitives < components < widgets < perspectives.
 * - a plugin's `view.tsx` imports only the view package, the kit (its index), learning and sources, never another plugin, the
 *   client or the host.
 * - `@gestalts/client` (the core in the browser) builds on the view package; the host on client, view, kit, learning and
 *   sources (learning, sources and the kit only for the runtime frames load).
 * - `@gestalts/vite` (the build preset, run by Node) imports only the view package's compiler.
 * External packages are always fine.
 */
const kit = 'packages/kit/src';
const host = 'packages/host/src';
const kitBelow: Record<string, string[]> = {
  primitive: [],
  component: ['primitive'],
  widget: ['component', 'primitive'],
  perspective: ['widget', 'component', 'primitive'],
  'kit-index': ['perspective', 'widget', 'component', 'primitive'],
};
const allowed: Record<string, string[]> = {
  view: [],
  vite: ['view'],
  learning: ['view'],
  sources: [],
  client: ['view'],
  ...Object.fromEntries(Object.entries(kitBelow).map(([t, below]) => [t, ['view', 'sources', ...below]])),
  plugin: ['view', 'kit-index', 'learning', 'sources'],
  debug: ['client', 'view'],
  host: ['client', 'view', 'kit-index', 'learning', 'sources', 'debug'],
};

export default defineConfig({
  ignorePatterns: ['**/dist', 'packages/client/wasm', '**/node_modules'],
  plugins: ['typescript', 'react', 'oxc', 'unicorn'],
  jsPlugins: [{ name: 'react-hooks-js', specifier: 'eslint-plugin-react-hooks' }, 'eslint-plugin-boundaries'],
  categories: { correctness: 'error' },
  settings: {
    'import/resolver': { typescript: { project: ['packages/*/tsconfig.json', 'plugins/tsconfig.json'] }, node: true },
    'boundaries/elements': [
      { type: 'view', pattern: 'packages/view/src' },
      { type: 'vite', pattern: 'packages/vite/src' },
      { type: 'learning', pattern: 'packages/learning/src' },
      { type: 'sources', pattern: 'packages/sources/src' },
      { type: 'client', pattern: 'packages/client/src' },
      { type: 'primitive', pattern: `${kit}/primitives` },
      { type: 'component', pattern: `${kit}/components` },
      { type: 'widget', pattern: `${kit}/widgets` },
      { type: 'perspective', pattern: `${kit}/perspectives` },
      // files directly in packages/kit/src: the index views import
      { type: 'kit-index', pattern: kit },
      { type: 'plugin', pattern: 'plugins/*', capture: ['plugin'] },
      { type: 'debug', pattern: `${host}/debug` },
      { type: 'host', pattern: host },
    ],
  },
  rules: {
    'react/rules-of-hooks': 'error',
    'react/exhaustive-deps': 'warn',
    'react-hooks-js/set-state-in-render': 'error',
    'react-hooks-js/immutability': 'error',
    'react-hooks-js/refs': 'error',
  },
  overrides: [{
    files: ['packages/*/src/**/*.{ts,tsx}', 'plugins/*/*.{ts,tsx}'],
    rules: {
      'boundaries/no-unknown-files': 'error',
      'boundaries/dependencies': ['error', {
        default: 'disallow',
        policies: [
          { allow: { dependency: { relationship: { to: 'internal' } } } },
          ...Object.entries(allowed).map(([type, to]) => ({
            from: { element: { type } },
            allow: { to: { element: { types: { anyOf: to.length ? to : ['none'] } } } },
          })),
        ],
      }],
    },
  }],
});
