import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Yml = { id: string; gestalt: string; name?: string; front?: string; tags?: string[]; blobs?: { label: string; file: string }[]; concepts?: Record<string, number>; from?: string; to?: string; weight?: number; kind?: string; members?: string[] };

const dir = join(import.meta.dirname, 'decks/greek-alphabet/notes');
const ymls = readdirSync(dir).map((f) => parse(readFileSync(join(dir, f), 'utf8')) as Yml);
const concepts = ymls.filter((y) => y.gestalt === 'concept@2');
const links = ymls.filter((y) => y.gestalt === 'concept-link@1');
const exercises = ymls.filter((y) => y.gestalt === 'flashcard@1');
const concept = (name: string) => concepts.find((c) => c.name === name);

describe('the Greek deck', () => {
  it('has every yml named after its id and listed in the deck', () => {
    for (const f of readdirSync(dir)) expect((parse(readFileSync(join(dir, f), 'utf8')) as Yml).id).toBe(f.replace(/\.yml$/, ''));
    const deck = ymls.find((y) => y.gestalt === 'deck@1')!;
    expect(new Set(deck.members)).toEqual(new Set(ymls.filter((y) => y !== deck).map((y) => y.id)));
  });

  it('practices each word fully, and each letter by its share of the word', () => {
    for (const e of exercises) {
      expect(e.concepts?.[concept(`grc:${e.front}`)!.id]).toBe(1);
      const letters = e.front!.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replaceAll('ς', 'σ');
      const held = concepts.filter((c) => /^grc:\p{L}$/u.test(c.name!) && e.concepts?.[c.id]);
      expect(held.reduce((sum, c) => sum + e.concepts![c.id], 0)).toBeCloseTo(1, 4);
      for (const c of held) {
        const letter = c.name!.slice(4);
        expect(e.concepts![c.id]).toBeCloseTo([...letters].filter((l) => l === letter).length / letters.length, 4);
      }
    }
  });

  it('has every card tagged for the trainer, with its picture and recording', () => {
    expect(exercises.length).toBeGreaterThan(0);
    for (const e of exercises) {
      expect(e.tags).toEqual(expect.arrayContaining(['alphabet-pronunciation', 'lang:grc', 'no-generic-practice']));
      expect(e.blobs?.map((b) => b.label).sort()).toEqual(['audio', 'back']);
    }
  });

  it('counts a repeated letter more than a single one', () => {
    const repeat = exercises.find((e) => { const l = e.front!.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replaceAll('ς', 'σ'); return new Set(l).size < l.length; })!;
    const shares = concepts.filter((c) => /^grc:\p{L}$/u.test(c.name!) && repeat.concepts?.[c.id]).map((c) => repeat.concepts![c.id]);
    expect(new Set(shares).size).toBeGreaterThan(1);
  });

  it('folds accents and final sigma into one letter', () => {
    expect(concept('grc:ς')).toBeUndefined();
    expect(concept('grc:ά')).toBeUndefined();
    expect(concept('grc:σ')).toBeDefined();
  });

  it('links every letter and word to the alphabet, letters more strongly', () => {
    const root = concept('grc:alphabet')!;
    expect(links).toHaveLength(concepts.length - 1);
    for (const c of concepts) {
      if (c === root) continue;
      const l = links.filter((x) => x.from === c.id);
      expect(l).toHaveLength(1);
      expect(l[0]).toMatchObject({ to: root.id, kind: 'part-of' });
      expect(l[0].weight).toBe(/^grc:\p{L}$/u.test(c.name!) ? 0.3 : 0.1);
    }
  });
});
