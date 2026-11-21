/**
 * What an agent making a view works against, sent with every turn: the contract (CLAUDE.md), the examples, and the
 * sources of what a view may import, where the contract says (`node_modules/@gestalts/<package>/src/`). Loaded on the
 * first turn, not with the page.
 */
const contract = import.meta.glob('../../agent-template/CLAUDE.md', { query: '?raw', import: 'default' });
const examples = import.meta.glob('../../agent-template/examples/**/*', { query: '?raw', import: 'default' });
const sources = import.meta.glob(
  ['../../../view/src/**/*.{ts,tsx}', '../../../kit/src/**/*.{ts,tsx}', '../../../learning/src/**/*.{ts,tsx}', '../../../sources/src/**/*.{ts,tsx}', '!../../../*/src/**/*.test.ts', '!../../../*/src/**/*.test.tsx'],
  { query: '?raw', import: 'default' },
);

async function load(globbed: Record<string, () => Promise<unknown>>, path: (key: string) => string): Promise<Record<string, string>> {
  const entries = await Promise.all(Object.entries(globbed).map(async ([k, f]) => [path(k), String(await f())] as const));
  return Object.fromEntries(entries);
}

let loaded: Promise<Record<string, string>> | undefined;

export function viewTemplate(): Promise<Record<string, string>> {
  loaded ??= Promise.all([
    load(contract, () => 'CLAUDE.md'),
    load(examples, (k) => k.replace('../../agent-template/', '')),
    load(sources, (k) => k.replace(/^\.\.\/\.\.\/\.\.\/(view|kit|learning|sources)\//, 'node_modules/@gestalts/$1/')),
  ]).then((parts) => Object.assign({}, ...parts) as Record<string, string>);
  return loaded;
}
