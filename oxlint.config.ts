import { defineConfig } from 'oxlint';

/**
 * Who may import whom (eslint-plugin-boundaries):
 * - `@gestalts/sdk` (the perspective port) imports nothing of ours; `@gestalts/learning` only the sdk.
 * - `@gestalts/kit` imports only the sdk, in layers: primitives < components < widgets < views.
 * - plugins (`plugins/<id>/ui`) import only the sdk, the kit (its index) and learning, never another plugin, the
 *   client or the host. That keeps them movable to repos of their own.
 * - `@gestalts/client` (the core in the browser) builds on the sdk; the host (`packages/ui`) on client, sdk and kit.
 * - `@gestalts/vite` (the build preset, run by Node) imports nothing of ours.
 * Apps (in their own repos) use the host, and load plugins only through `virtual:gestalts-plugins`.
 * External packages are always fine.
 */
const kit = 'packages/kit/src';
const host = 'packages/ui/src';
const kitBelow: Record<string, string[]> = {
  primitive: [],
  component: ['primitive'],
  widget: ['component', 'primitive'],
  view: ['widget', 'component', 'primitive'],
  'kit-index': ['view', 'widget', 'component', 'primitive'],
};
const allowed: Record<string, string[]> = {
  sdk: [],
  vite: [],
  learning: ['sdk'],
  client: ['sdk'],
  ...Object.fromEntries(Object.entries(kitBelow).map(([t, below]) => [t, ['sdk', ...below]])),
  plugin: ['sdk', 'kit-index', 'learning'],
  debug: ['client', 'sdk'],
  host: ['client', 'sdk', 'kit-index', 'debug'],
  'host-perspective': ['client', 'sdk', 'kit-index'],
};

export default defineConfig({
  ignorePatterns: ['**/dist', 'packages/client/wasm', '**/node_modules'],
  plugins: ['typescript', 'react', 'oxc', 'unicorn'],
  jsPlugins: [{ name: 'react-hooks-js', specifier: 'eslint-plugin-react-hooks' }, 'eslint-plugin-boundaries'],
  categories: { correctness: 'error' },
  settings: {
    'import/resolver': { typescript: { project: ['packages/*/tsconfig.json', 'plugins/*/tsconfig.json'] }, node: true },
    'boundaries/elements': [
      { type: 'sdk', pattern: 'packages/sdk/src' },
      { type: 'vite', pattern: 'packages/vite/src' },
      { type: 'learning', pattern: 'packages/learning/src' },
      { type: 'client', pattern: 'packages/client/src' },
      { type: 'primitive', pattern: `${kit}/primitives` },
      { type: 'component', pattern: `${kit}/components` },
      { type: 'widget', pattern: `${kit}/widgets` },
      { type: 'view', pattern: `${kit}/views` },
      // files directly in packages/kit/src: the index plugins import
      { type: 'kit-index', pattern: kit },
      { type: 'plugin', pattern: 'plugins/*/ui/src', capture: ['plugin'] },
      { type: 'debug', pattern: `${host}/debug` },
      { type: 'host', pattern: `${host}/host` },
      { type: 'host-perspective', pattern: `${host}/perspectives` },
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
    files: ['packages/*/src/**/*.{ts,tsx}', 'plugins/*/ui/src/**/*.{ts,tsx}'],
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
