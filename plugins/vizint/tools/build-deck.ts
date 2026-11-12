// The examples deck from @gestalts/viz's examples: each example folder (viz.ts, viz.yml, files/) becomes a viz@1 yml
// with its built page as a blob. Then publish it:
//
//   node plugins/vizint/tools/build-deck.ts && mise run publish-data plugins/vizint/decks/examples
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { buildPage } from '../../../packages/viz/build/build.ts';

const root = resolve(import.meta.dirname, '../../..');
const examples = join(root, 'packages/viz/examples');
const deck = join(root, 'plugins/vizint/decks/examples');

await rm(join(deck, 'notes'), { recursive: true, force: true });
await rm(join(deck, 'blobs'), { recursive: true, force: true });
await mkdir(join(deck, 'notes'), { recursive: true });
await mkdir(join(deck, 'blobs'), { recursive: true });

const members: string[] = [];
for (const name of (await readdir(examples)).sort()) {
  const dir = join(examples, name);
  const meta = parse(await readFile(join(dir, 'viz.yml'), 'utf8')) as Record<string, string>;
  const html = await buildPage(dir);
  await writeFile(join(deck, 'blobs', `${name}.html`), html);
  const files: { file: string; label: string }[] = [];
  for (const f of await readdir(join(dir, 'files')).catch(() => [] as string[])) {
    await writeFile(join(deck, 'blobs', `${name}-${f}`), await readFile(join(dir, 'files', f)));
    files.push({ file: `${name}-${f}`, label: f });
  }
  const id = `viz-${name}`;
  const yml = {
    id, gestalt: 'viz@1', title: meta.title, intro: meta.intro, spec: meta.spec, outro: meta.outro,
    source: await readFile(join(dir, 'viz.ts'), 'utf8'),
    ...(files.length ? { files } : {}),
    built: `${name}.html`,
    generator: 'hand-written example',
  };
  await writeFile(join(deck, 'notes', `${id}.yml`), stringify(yml, { lineWidth: 0 }));
  members.push(id);
  console.log(`${id}: ${Math.round(Buffer.byteLength(html) / 1024)} KB`);
}
await writeFile(join(deck, 'notes', 'deck-vizint-examples.yml'), stringify({
  id: 'deck-vizint-examples', gestalt: 'deck@1', name: 'examples', title: 'Examples', members,
}));
