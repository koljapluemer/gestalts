import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Yml = {
  id: string; gestalt: string; name?: string; members?: string[]; model?: string; country?: string; image?: string;
  lookalikes?: string[]; distractors?: string[]; concepts?: Record<string, number>; chance?: number; tags?: string[];
  from?: string; to?: string; weight?: number; sources?: { to: string; label: string }[]; in?: string;
};

const read = (dir: string) => readdirSync(join(dir, 'notes')).map((f) => [f, readFileSync(join(dir, 'notes', f), 'utf8')] as const);
const deck = join(import.meta.dirname, 'decks/flags');
const files = read(deck);
const ymls = files.map(([, t]) => parse(t) as Yml);
const of = (g: string) => ymls.filter((y) => y.gestalt === g);
const byId = new Map(ymls.map((y) => [y.id, y]));
// world-map's deck, read as data (a plugin's files import no other plugin)
const worldMapDeck = join(import.meta.dirname, '../world-map/decks/world-map');
const worldMap = new Map(read(worldMapDeck).map(([f, t]) => [f.replace(/\.yml$/, ''), t]));
const mapYml = [...worldMap.values()].map((t) => parse(t) as Yml & { geometry?: string }).find((y) => y.gestalt === 'map@1')!;
const regions = (JSON.parse(readFileSync(join(worldMapDeck, 'blobs', mapYml.geometry!), 'utf8')) as { regions: Record<string, { name: string }> }).regions;
const countries = JSON.parse(readFileSync(join(import.meta.dirname, 'tools/data/countries.json'), 'utf8')) as
  Record<string, { map: string | null; name: string; skip?: string }>;

describe('the flags deck', () => {
  const flags = of('flag@1');
  const codes = new Set(flags.map((f) => f.country!));

  it('lists everything in its deck yml, each named after its id', () => {
    for (const [f, t] of files) expect((parse(t) as Yml).id).toBe(f.replace(/\.yml$/, ''));
    const d = of('deck@1')[0];
    expect(new Set(d.members)).toEqual(new Set(ymls.filter((y) => y !== d).map((y) => y.id)));
  });

  it('has a flag for every country not skipped, each with its image and credit', () => {
    expect([...codes].sort()).toEqual(Object.keys(countries).filter((c) => !countries[c].skip).sort());
    for (const f of flags) {
      expect(f.name).toBe(countries[f.country!].name);
      expect(existsSync(join(deck, 'blobs', f.image!)), f.id).toBe(true);
      expect(byId.get(f.model!)?.gestalt).toBe('item-model@1');
      expect(f.chance).toBe(0.5);
      expect(f.tags).toContain('flags-practice');
      expect(byId.get(f.sources![0].to)?.gestalt).toBe('source@1');
    }
  });

  it('draws wrong options only from other flags', () => {
    for (const f of flags) {
      for (const c of [...(f.lookalikes ?? []), ...(f.distractors ?? [])]) {
        expect(codes.has(c), `${f.id}: ${c}`).toBe(true);
        expect(c).not.toBe(f.country);
      }
      for (const c of f.distractors ?? []) expect(f.lookalikes ?? []).not.toContain(c);
    }
    expect(flags.filter((f) => f.lookalikes?.length).length).toBeGreaterThan(80);
  });

  it('practises a flag concept per flag, linked both ways to world-map\'s concept of the country', () => {
    for (const f of flags) {
      const [id] = Object.keys(f.concepts!);
      expect(byId.get(id)?.name).toBe(`flag: ${f.name}`);
      const map = countries[f.country!].map;
      const links = of('concept-link@1').filter((l) => l.from === id || l.to === id);
      if (!map) { expect(links).toHaveLength(0); continue; }
      const other = links.find((l) => l.from === id)!.to!;
      expect(links.map((l) => [l.from, l.to]).sort()).toEqual([[other, id], [id, other]].sort());
      expect(byId.get(other)?.name, f.id).toBe(`geography: ${regions[map].name}`);
      for (const l of links) expect(l.weight).toBeGreaterThan(0);
    }
  });

  it('holds world-map\'s geography concepts exactly as world-map does', () => {
    const geography = of('concept@3').filter((c) => c.name!.startsWith('geography: '));
    expect(geography.length).toBeGreaterThan(200);
    for (const c of geography) expect(files.find(([f]) => f === `${c.id}.yml`)![1], c.id).toBe(worldMap.get(c.id));
    expect(geography).toHaveLength(Object.values(countries).filter((c) => c.map && !c.skip).length);
    const set = geography[0].in!;
    expect(files.find(([f]) => f === `${set}.yml`)![1]).toBe(worldMap.get(set));
  });

  it('has every flag in the flags, and the flags in nothing', () => {
    const flagConcepts = of('concept@3').filter((c) => c.name!.startsWith('flag: '));
    expect(flagConcepts).toHaveLength(flags.length);
    const set = byId.get(flagConcepts[0].in!)!;
    expect(set).toMatchObject({ gestalt: 'concept@2', name: 'flag: country flags' });
    for (const c of flagConcepts) expect(c.in).toBe(set.id);
  });
});
