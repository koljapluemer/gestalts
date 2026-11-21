/**
 * What the viz agent works against, sent with every build: the contract (CLAUDE.md), the finished examples with what
 * they were made from, and @gestalts/viz's sources (`viz-sources/`, read-only). Loaded on the first build.
 */
const contract = import.meta.glob('../../../../packages/viz/agent/CLAUDE.md', { query: '?raw', import: 'default' });
const examples = import.meta.glob('../../../../packages/viz/examples/*/viz.{ts,yml}', { query: '?raw', import: 'default' });
const exampleFiles = import.meta.glob('../../../../packages/viz/examples/*/files/*', { query: '?url', import: 'default' });
const sources = import.meta.glob(['../../../../packages/viz/src/*.ts', '!../../../../packages/viz/src/*.test.ts'], { query: '?raw', import: 'default' });

const VIZ = '../../../../packages/viz/';

const base64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export type Template = { files: Record<string, string>; binary: Record<string, string> };

async function load(): Promise<Template> {
  const files: Record<string, string> = {};
  const binary: Record<string, string> = {};
  await Promise.all([
    ...Object.entries(contract).map(async ([, f]) => { files['CLAUDE.md'] = String(await f()); }),
    ...Object.entries(examples).map(async ([k, f]) => { files[k.replace(VIZ, '')] = String(await f()); }),
    ...Object.entries(sources).map(async ([k, f]) => { files[k.replace(`${VIZ}src/`, 'viz-sources/')] = String(await f()); }),
    ...Object.entries(exampleFiles).map(async ([k, f]) => {
      const r = await fetch(String(await f()));
      binary[k.replace(VIZ, '')] = base64(new Uint8Array(await r.arrayBuffer()));
    }),
  ]);
  return { files, binary };
}

let loaded: Promise<Template> | undefined;
export function vizTemplate(): Promise<Template> {
  loaded ??= load().catch((e: unknown) => { loaded = undefined; throw e; });
  return loaded;
}
