import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { geographyConcept } from './tools/concepts.ts';

type Yml = {
  id: string; gestalt: string; name?: string; members?: string[]; model?: string; country?: string; group?: string;
  zoom?: number; distractors?: string[]; priority?: number; concepts?: Record<string, number>; chance?: number;
  countries?: string[]; geometry?: string; sources?: { to: string; label: string }[]; tags?: string[];
};
type Geometry = { scale: number; bounds: number[]; regions: Record<string, { name: string; d: string; centroid: number[]; bounds: number[]; size: number }> };

const deck = join(import.meta.dirname, 'decks/world-map');
const files = readdirSync(join(deck, 'notes')).map((f) => [f, parse(readFileSync(join(deck, 'notes', f), 'utf8')) as Yml] as const);
const ymls = files.map(([, y]) => y);
const of = (g: string) => ymls.filter((y) => y.gestalt === g);
const byId = new Map(ymls.map((y) => [y.id, y]));

const CHANCE: Record<string, number> = {
  'find-in-neighborhood': 0, 'find-on-world-map': 0, 'identify-country': 0.5, 'distractor-choice': 0.5, 'group-sequence': 0.5,
};

describe('the world-map deck', () => {
  const [map] = of('map@1');
  const geometry = JSON.parse(readFileSync(join(deck, 'blobs', map.geometry!), 'utf8')) as Geometry;
  const codes = new Set(Object.keys(geometry.regions));
  const exercises = of('map-exercise@1');

  it('lists everything in its deck yml, each named after its id', () => {
    for (const [f, y] of files) expect(y.id).toBe(f.replace(/\.yml$/, ''));
    const d = of('deck@1')[0];
    expect(new Set(d.members)).toEqual(new Set(ymls.filter((y) => y !== d).map((y) => y.id)));
  });

  it('has one map, every country in it drawn, credited to Natural Earth', () => {
    expect(of('map@1')).toHaveLength(1);
    expect(codes.size).toBe(240);
    for (const r of Object.values(geometry.regions)) {
      expect(r.name).toBeTruthy();
      expect(r.d).toMatch(/^m/);
      expect(r.centroid).toHaveLength(2);
      expect(r.bounds).toHaveLength(4);
      expect(r.size).toBeGreaterThan(0);
    }
    expect(byId.get(map.sources![0].to)?.gestalt).toBe('source@1');
  });

  it('has one concept per country', () => {
    expect(of('concept@2')).toHaveLength(codes.size);
    for (const [code, r] of Object.entries(geometry.regions)) {
      expect(byId.get(geographyConcept(code))?.name, code).toBe(`geography: ${r.name}`);
    }
  });

  it('has exercises on known countries, practising that country with the chance of their kind', () => {
    expect(exercises.length).toBeGreaterThan(300);
    for (const e of exercises) {
      const model = byId.get(e.model!);
      expect(model?.gestalt, e.id).toBe('item-model@1');
      expect(codes.has(e.country!), e.id).toBe(true);
      expect(e.chance).toBe(CHANCE[model!.name!]);
      expect(model!.chance).toBe(CHANCE[model!.name!]);
      expect(Object.keys(e.concepts!)).toEqual([geographyConcept(e.country!)]);
      expect([1, 2, 3]).toContain(e.priority);
      expect(e.tags).toContain('world-map');
      for (const d of e.distractors ?? []) expect(codes.has(d), `${e.id}: ${d}`).toBe(true);
      if (model!.name === 'distractor-choice') expect(e.distractors!.length).toBeGreaterThan(0);
      if (model!.name === 'find-in-neighborhood' || model!.name === 'distractor-choice') expect(e.zoom).toBeGreaterThan(0);
    }
  });

  it('has a group-sequence exercise for every country of every group, and only those', () => {
    const groups = of('country-group@1');
    expect(groups.length).toBeGreaterThan(0);
    const steps = exercises.filter((e) => e.group);
    for (const g of groups) {
      for (const c of g.countries!) expect(codes.has(c)).toBe(true);
      expect(steps.filter((e) => e.group === g.id).map((e) => e.country).sort()).toEqual([...g.countries!].sort());
    }
    for (const e of steps) expect(byId.get(e.model!)?.name).toBe('group-sequence');
  });
});
