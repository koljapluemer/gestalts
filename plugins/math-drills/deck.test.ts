import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Option = { text: string; correct?: boolean; response?: string };
type Yml = {
  id: string; gestalt: string; name?: string; members?: string[]; license?: string; url?: string;
  concepts?: Record<string, number>; responses?: Record<string, { label: string; concepts: Record<string, number> }>;
  model?: string; prompt?: string; options?: Option[]; chance?: number; tags?: string[];
  sources?: { to: string; label: string }[]; from?: string; to?: string; weight?: number;
};

const decksDir = join(import.meta.dirname, 'decks');
const read = (deck: string) => {
  const dir = join(decksDir, deck, 'notes');
  return readdirSync(dir).map((f) => [f, parse(readFileSync(join(dir, f), 'utf8')) as Yml] as const);
};
/** Markdown maths as the kit reads it: `$…$`, no whitespace just inside the ends */
const MATH = /^\$\S(.*\S)?\$$/;

for (const deck of readdirSync(decksDir)) {
  const files = read(deck);
  const ymls = files.map(([, y]) => y);
  const of = (g: string) => ymls.filter((y) => y.gestalt === g);
  const items = of('multiple-choice@1');
  const models = of('item-model@1');
  const concepts = new Map(of('concept@2').map((c) => [c.id, c]));
  const links = of('concept-link@1');

  describe(`the ${deck} deck`, () => {
    it('lists everything in its deck yml, each named after its id', () => {
      for (const [f, y] of files) expect(y.id).toBe(f.replace(/\.yml$/, ''));
      const d = of('deck@1')[0];
      expect(new Set(d.members)).toEqual(new Set(ymls.filter((y) => y !== d).map((y) => y.id)));
    });

    it('is one item model and the items it made', () => {
      expect(models).toHaveLength(1);
      expect(items.length).toBeGreaterThan(0);
      for (const q of items) {
        expect(q.model).toBe(models[0].id);
        expect(q.concepts).toEqual(models[0].concepts);
        expect(q.tags).toContain('math-drills');
      }
    });

    it('has questions with one right answer among distinct options, in Markdown maths', () => {
      for (const q of items) {
        const opts = q.options!;
        expect(opts.length).toBeGreaterThanOrEqual(2);
        expect(opts.filter((o) => o.correct)).toHaveLength(1);
        expect(new Set(opts.map((o) => o.text)).size).toBe(opts.length);
        expect(q.chance).toBeCloseTo(1 / opts.length);
        for (const t of [q.prompt!, ...opts.map((o) => o.text)]) expect(t, t).toMatch(MATH);
      }
    });

    it('explains every response its options name', () => {
      const responses = models[0].responses ?? {};
      for (const q of items) for (const o of q.options!) if (o.response) expect(responses, o.response).toHaveProperty(o.response);
      for (const r of Object.values(responses)) {
        expect(r.label).toBeTruthy();
        expect(Object.keys(r.concepts).length).toBeGreaterThan(0);
      }
    });

    it('refers only to concepts it has, all of them maths, and links no concept to itself', () => {
      const used = [models[0].concepts, ...Object.values(models[0].responses ?? {}).map((r) => r.concepts)];
      for (const ws of used) for (const id of Object.keys(ws ?? {})) expect(concepts.has(id), id).toBe(true);
      for (const c of concepts.values()) expect(c.name).toMatch(/^math: /);
      for (const l of links) {
        expect(concepts.has(l.from!) && concepts.has(l.to!)).toBe(true);
        expect(l.from).not.toBe(l.to);
        expect(l.weight).toBeGreaterThan(0);
      }
    });

    it('credits Stembridge, under CC BY 4.0', () => {
      const [source] = of('source@1');
      expect(source).toMatchObject({ license: 'CC-BY-4.0', url: 'https://github.com/koljapluemer/stembridge' });
      for (const y of [...items, ...models]) expect(y.sources).toEqual([{ to: source.id, label: 'from' }]);
      expect(readFileSync(join(decksDir, deck, 'LICENSE.md'), 'utf8')).toContain('CC BY 4.0');
    });
  });
}

describe('the math decks together', () => {
  it('hold a shared concept as the same yml', () => {
    const seen = new Map<string, string>();
    for (const deck of readdirSync(decksDir)) {
      for (const [, y] of read(deck)) {
        if (y.gestalt !== 'concept@2' && y.gestalt !== 'source@1') continue;
        const text = JSON.stringify(y);
        expect(seen.get(y.id) ?? text, y.id).toBe(text);
        seen.set(y.id, text);
      }
    }
  });
});
