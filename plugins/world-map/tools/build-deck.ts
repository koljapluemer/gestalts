// The world-map deck from the data in tools/data (exported once from sam-learns-things' world-map CMS, which keys every
// country by Natural Earth's `adm0_a3` and names it by `name_long`):
//
// - map.geo.json becomes one blob, every country already projected (Mercator) to an SVG path, with its centroid and
//   bounds. d3-geo runs here, not in the view, so the view only scales and moves; the projection has no rotation, so
//   every view of it is the same paths under another affine transform. Paths are made at a world about REF px wide,
//   so d3's resampling and clipping at the antimeridian are what the old app drew.
// - every country is a `concept@3` (`geography: <name>`, its id from its code by tools/concepts.ts, which
//   flags-practice's builder shares) `in` `geography: countries`, each exercise kind an `item-model@1`, and each enabled exercise of a country
//   (countries.json) a `map-exercise@1`; each country group (groups.json) a `country-group@1` with a group-sequence
//   `map-exercise@1` per country in it.
//
//   node plugins/world-map/tools/build-deck.ts && mise run publish-data plugins/world-map/decks/world-map
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { geoCentroid, geoMercator, geoPath } from 'd3-geo';
import type { Feature, FeatureCollection } from 'geojson';
import { stringify } from 'yaml';
import { COUNTRIES, geographyConcept, geographyYml } from './concepts.ts';

const plugin = resolve(import.meta.dirname, '..');
const data = join(plugin, 'tools/data');
const deck = join(plugin, 'decks/world-map');

/** the world's width in px the paths are made at (and so resampled for) */
const REF = 1000;
const R = REF / (2 * Math.PI);
/** decimals kept: a thousandth of a reference px, still well under a screen px zoomed in on the smallest islands */
const DIGITS = 3;
const DEFAULT_PRIORITY = 2;
const TAGS = ['world-map'];

type Countries = Record<string, {
  learningPriority?: number;
  neighborhood?: { enabled: boolean; zoom: number };
  worldMap?: { enabled: boolean };
  identifyCountry?: { enabled: boolean };
  distractorChoice?: { enabled: boolean; zoom: number; distractors: string[] };
}>;
type Groups = Record<string, { name: string; countries: string[]; enabled: boolean }>;

const json = async <T>(f: string) => JSON.parse(await readFile(join(data, f), 'utf8')) as T;
const geo = await json<FeatureCollection>('map.geo.json');
const countries = await json<Countries>('countries.json');
const groups = await json<Groups>('groups.json');

const round = (v: number) => Math.round(v * 10 ** DIGITS) / 10 ** DIGITS;
const num = (v: number) => String(round(v) || 0);

// ---------- geometry ----------

const projection = geoMercator().scale(R).translate([0, 0]);
const pathOf = geoPath(projection);

/** An SVG path in relative commands, each step between rounded points so rounding doesn't add up. */
function svgPath(f: Feature): string {
  let out = '';
  let x = 0;
  let y = 0;
  let start: [number, number] = [0, 0];
  const step = (cmd: string, px: number, py: number) => {
    const [rx, ry] = [round(px), round(py)];
    out += `${cmd}${num(rx - x)} ${num(ry - y)}`;
    [x, y] = [rx, ry];
  };
  geoPath(projection, {
    moveTo: (px, py) => { step('m', px, py); start = [x, y]; },
    lineTo: (px, py) => step('l', px, py),
    closePath: () => { out += 'z'; [x, y] = start; },
    arc: () => {},
  } as unknown as CanvasRenderingContext2D)(f);
  return out;
}

const box = (b: [[number, number], [number, number]]) => b.flat().map(round);

const regions: Record<string, { name: string; d: string; centroid: number[]; bounds: number[]; size: number }> = {};
const names = new Map<string, string>();
for (const f of geo.features) {
  const code = f.properties?.code as string;
  const name = f.properties?.name as string;
  if (!code || !name) throw new Error(`a feature without code or name: ${JSON.stringify(f.properties)}`);
  const b = pathOf.bounds(f);
  const [w, h] = [b[1][0] - b[0][0], b[1][1] - b[0][1]];
  regions[code] = {
    name,
    d: svgPath(f),
    centroid: (projection(geoCentroid(f)) ?? [0, 0]).map(round),
    bounds: box(b),
    // its largest on-screen dimension at the world view; a box over half the world can only be one straddling the
    // antimeridian (Fiji), whose real width is not that, so only the height counts then
    size: round(w > Math.PI * R ? h : Math.max(w, h)),
  };
  names.set(code, name);
}
const geometry = JSON.stringify({ projection: 'mercator', scale: R, bounds: box(pathOf.bounds(geo)), regions });

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
const known = (code: string, where: string) => {
  if (!names.has(code)) throw new Error(`${where}: ${code} is not in map.geo.json`);
  return code;
};

const SOURCE = 'source-natural-earth';
const credit = [{ to: SOURCE, label: 'from' }];
await put({
  id: SOURCE, gestalt: 'source@1', key: 'naturalearth', entrytype: 'online', title: 'Natural Earth: Admin 0 – Countries',
  organization: ['Natural Earth'], url: 'https://www.naturalearthdata.com',
});
await writeFile(join(deck, 'blobs', 'world.json'), geometry);
await put({ id: 'map-world', gestalt: 'map@1', name: 'world', title: 'World', geometry: 'world.json', sources: credit });

const concept = new Map<string, string>();
await put(COUNTRIES);
for (const [code, name] of names) {
  concept.set(code, geographyConcept(code));
  await put(geographyYml(code, name));
}

const KINDS = {
  'find-in-neighborhood': { title: 'Find it in its neighborhood', chance: 0 },
  'find-on-world-map': { title: 'Find it on the world map', chance: 0 },
  'identify-country': { title: 'Which country is this?', chance: 0.5 },
  'distractor-choice': { title: 'Which country is highlighted?', chance: 0.5 },
  'group-sequence': { title: 'Name each country of a group', chance: 0.5 },
} as const;
type Kind = keyof typeof KINDS;
const model = (k: Kind) => `item-model-world-map-${k}`;
for (const [k, { title, chance }] of Object.entries(KINDS)) {
  await put({ id: model(k as Kind), gestalt: 'item-model@1', name: k, title, engine: `world-map/${k}`, chance, tags: TAGS });
}

const exercise = (code: string, k: Kind, rest: Record<string, unknown> = {}, suffix = k) => put({
  id: `map-exercise-${code.toLowerCase()}-${suffix}`, gestalt: 'map-exercise@1', model: model(k), country: code, ...rest,
  priority: countries[code]?.learningPriority ?? DEFAULT_PRIORITY,
  concepts: { [concept.get(code)!]: 1 }, chance: KINDS[k].chance, tags: TAGS,
});

let count = 0;
for (const [code, c] of Object.entries(countries).sort(([a], [b]) => a.localeCompare(b))) {
  known(code, 'countries.json');
  if (c.neighborhood?.enabled) { await exercise(code, 'find-in-neighborhood', { zoom: c.neighborhood.zoom }); count++; }
  if (c.worldMap?.enabled) { await exercise(code, 'find-on-world-map'); count++; }
  if (c.identifyCountry?.enabled) { await exercise(code, 'identify-country'); count++; }
  const dc = c.distractorChoice;
  if (dc?.enabled && dc.distractors.length) {
    await exercise(code, 'distractor-choice', { zoom: dc.zoom, distractors: dc.distractors.map((d) => known(d, `${code}'s distractors`)) });
    count++;
  }
}
for (const [g, group] of Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))) {
  if (!group.enabled || !group.countries.length) continue;
  const id = `country-group-${g}`;
  await put({ id, gestalt: 'country-group@1', name: g, title: group.name, countries: group.countries.map((c) => known(c, `group ${g}`)) });
  for (const code of group.countries) { await exercise(code, 'group-sequence', { group: id }, `group-${g}`); count++; }
}

await put({ id: 'deck-world-map', gestalt: 'deck@1', name: 'world-map', title: 'World Map', members: [...members] });
await writeFile(join(deck, 'LICENSE.md'), `# World Map

The country shapes are [Natural Earth](https://www.naturalearthdata.com)'s Admin 0 – Countries, which is in the public
domain. Credit: Natural Earth.

Changes: the shapes are projected (Mercator) and stored as SVG paths; which exercises each country has, its zoom levels,
distractors and groups were curated for this deck.
`);
console.log(`${names.size} countries, ${count} exercises, geometry ${Math.round(Buffer.byteLength(geometry) / 1024)} KB`);
