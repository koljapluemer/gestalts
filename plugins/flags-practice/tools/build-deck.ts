// The flags deck from the data in tools/data (the flags of sam-learns-things' learn-flags, from
// iso-country-flags-svg-collection):
//
// - countries.json: each ISO 3166 alpha-2 code's name on the answer, its code in world-map's geometry (`map`, null if
//   it has no shape there), and `skip` with the reason for a flag not asked (one that is another country's flag);
// - flags/<code>.svg: the flag of every country not skipped, minified with svgo into a blob;
// - lookalikes.json: groups of flags that are confused, each flag's `lookalikes` the others of its groups;
// - world-map's tools/data/countries.json: its countries' curated distractors (their region), each flag's
//   `distractors` those that have a flag here.
//
// Every flag is a `flag: <name>` concept, linked both ways to world-map's `geography: <name>` concept of the same
// country (whose yml is written here too, the same as world-map's, by tools/concepts.ts there), and a `flag@1` made
// by one `item-model@1`.
//
//   node plugins/flags-practice/tools/build-deck.ts && mise run publish-data plugins/flags-practice/decks/flags
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FeatureCollection } from 'geojson';
import { optimize } from 'svgo';
import { stringify } from 'yaml';
import { geographyConcept, geographyName, sha } from '../../world-map/tools/concepts.ts';

const plugin = resolve(import.meta.dirname, '..');
const data = join(plugin, 'tools/data');
const worldMap = resolve(plugin, '../world-map/tools/data');
const deck = join(plugin, 'decks/flags');

const TAGS = ['flags-practice'];
const CHANCE = 0.5;
/** how much evidence about a country's flag says about where it is, and the other way round: little */
const LINK_WEIGHT = 0.1;
const LINK_SOURCE = 'flags-practice/flags';

type Countries = Record<string, { map: string | null; name: string; skip?: string }>;
type MapCountries = Record<string, { distractorChoice?: { distractors: string[] } }>;

const json = async <T>(f: string) => JSON.parse(await readFile(f, 'utf8')) as T;
const countries = await json<Countries>(join(data, 'countries.json'));
const lookalikeGroups = await json<Record<string, string[]>>(join(data, 'lookalikes.json'));
const geo = await json<FeatureCollection>(join(worldMap, 'map.geo.json'));
const mapCountries = await json<MapCountries>(join(worldMap, 'countries.json'));
const mapNames = new Map(geo.features.map((f) => [f.properties?.code as string, f.properties?.name as string]));

const asked = Object.keys(countries).filter((c) => !countries[c].skip).sort();
const isFlag = new Set(asked);
const svgs = new Set((await readdir(join(data, 'flags'))).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4).toUpperCase()));
for (const c of asked) if (!svgs.has(c)) throw new Error(`${c} has no flags/${c.toLowerCase()}.svg`);
for (const c of svgs) if (!isFlag.has(c)) throw new Error(`flags/${c.toLowerCase()}.svg is not a flag asked in countries.json`);
const byMapCode = new Map<string, string>();
for (const c of asked) {
  const m = countries[c].map;
  if (!m) continue;
  if (!mapNames.has(m)) throw new Error(`${c}: ${m} is not in world-map's map.geo.json`);
  if (byMapCode.has(m)) throw new Error(`${c} and ${byMapCode.get(m)} are both ${m}`);
  byMapCode.set(m, c);
}

const lookalikes = new Map<string, Set<string>>(asked.map((c) => [c, new Set()]));
for (const [g, codes] of Object.entries(lookalikeGroups)) {
  for (const c of codes) if (!isFlag.has(c)) throw new Error(`look-alikes "${g}": ${c} is not a flag asked`);
  for (const c of codes) for (const o of codes) if (o !== c) lookalikes.get(c)!.add(o);
}

// ---------- ymls ----------

await rm(join(deck, 'notes'), { recursive: true, force: true });
await rm(join(deck, 'blobs'), { recursive: true, force: true });
await mkdir(join(deck, 'notes'), { recursive: true });
await mkdir(join(deck, 'blobs'), { recursive: true });

const members: string[] = [];
const put = async (yml: { id: string } & Record<string, unknown>) => {
  await writeFile(join(deck, 'notes', `${yml.id}.yml`), stringify(yml, { lineWidth: 0 }));
  members.push(yml.id);
};

const SOURCE = 'source-iso-country-flags-svg-collection';
await put({
  id: SOURCE, gestalt: 'source@1', key: 'isocountryflagssvg', entrytype: 'online', title: 'iso-country-flags-svg-collection',
  author: ['Joielechong'], url: 'https://github.com/joielechong/iso-country-flags-svg-collection',
});
const MODEL = 'item-model-flags-practice-name-the-flag';
await put({ id: MODEL, gestalt: 'item-model@1', name: 'name-the-flag', title: 'Whose flag is this?', engine: 'flags-practice/name-the-flag', chance: CHANCE, tags: TAGS });

const flagConcept = (code: string) => `concept-${sha(`flag:${code}`)}`;
const link = (from: string, to: string) => put({
  id: `link-${sha(`${from}>${to}`)}`, gestalt: 'concept-link@1', from, to, weight: LINK_WEIGHT, kind: 'same-country', source: LINK_SOURCE,
});

let before = 0;
let after = 0;
for (const code of asked) {
  const { map, name } = countries[code];
  const raw = await readFile(join(data, 'flags', `${code.toLowerCase()}.svg`), 'utf8');
  const svg = optimize(raw, { multipass: true }).data;
  before += Buffer.byteLength(raw);
  after += Buffer.byteLength(svg);
  const blob = `${code.toLowerCase()}.svg`;
  await writeFile(join(deck, 'blobs', blob), svg);

  const concept = flagConcept(code);
  await put({ id: concept, gestalt: 'concept@2', name: `flag: ${name}` });
  if (map) {
    const geography = geographyConcept(map);
    await put({ id: geography, gestalt: 'concept@2', name: geographyName(mapNames.get(map)!) });
    await link(concept, geography);
    await link(geography, concept);
  }

  const alike = [...lookalikes.get(code)!].sort();
  const region = (map ? mapCountries[map]?.distractorChoice?.distractors ?? [] : [])
    .map((m) => byMapCode.get(m))
    .filter((c): c is string => !!c && c !== code && !alike.includes(c));
  await put({
    id: `flag-${code.toLowerCase()}`, gestalt: 'flag@1', model: MODEL, country: code, name, image: blob,
    ...(alike.length ? { lookalikes: alike } : {}), ...(region.length ? { distractors: [...new Set(region)] } : {}),
    concepts: { [concept]: 1 }, chance: CHANCE, tags: TAGS, sources: [{ to: SOURCE, label: 'from' }],
  });
}

await put({ id: 'deck-flags', gestalt: 'deck@1', name: 'flags', title: 'Flags', members: [...members] });
await writeFile(join(deck, 'LICENSE.md'), `# Flags

The flags are [iso-country-flags-svg-collection](https://github.com/joielechong/iso-country-flags-svg-collection)'s,
which says: "Most of the country flag icons are licensed under the Public Domain." Credit: iso-country-flags-svg-collection.

Changes: the SVGs are minified (svgo); flags that are another country's (France's for its territories, …) and three
files that held another flag are left out; the names, which flags look alike and the regions wrong options come from
were curated for this deck.
`);
const kb = (n: number) => Math.round(n / 1024);
console.log(`${asked.length} flags, ${byMapCode.size} on world-map's map, SVGs ${kb(before)} KB → ${kb(after)} KB`);
