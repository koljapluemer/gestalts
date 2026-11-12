import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Yml = {
  id: string; gestalt: string; name?: string; front?: string; context?: string; back?: string; tags?: string[];
  concepts?: Record<string, number>; sources?: { to: string; label: string }[]; from?: string; to?: string; weight?: number;
  members?: string[]; license?: string; url?: string;
};

const decksDir = join(import.meta.dirname, 'decks');

for (const deck of readdirSync(decksDir)) {
  const dir = join(decksDir, deck, 'notes');
  const ymls = readdirSync(dir).map((f) => parse(readFileSync(join(dir, f), 'utf8')) as Yml);
  const of = (g: string) => ymls.filter((y) => y.gestalt === g);
  const cards = of('flashcard@1');
  const concepts = new Map(of('concept@2').map((c) => [c.id, c]));
  const links = of('concept-link@1');
  const lang = cards[0]?.tags?.find((t) => t.startsWith('lang:'))?.slice(5);
  const main = (c: Yml) => Object.entries(c.concepts ?? {}).filter(([, w]) => w === 1).map(([id]) => id);

  describe(`the ${deck} deck`, () => {
    it('lists everything in its deck yml, each named after its id', () => {
      for (const f of readdirSync(dir)) expect((parse(readFileSync(join(dir, f), 'utf8')) as Yml).id).toBe(f.replace(/\.yml$/, ''));
      const d = of('deck@1')[0];
      expect(new Set(d.members)).toEqual(new Set(ymls.filter((y) => y !== d).map((y) => y.id)));
    });

    it('has cards for one language, for English speakers, kept to this view', () => {
      expect(cards.length).toBeGreaterThan(20);
      for (const c of cards) {
        expect(c.front && c.back).toBeTruthy();
        expect(c.tags).toEqual(expect.arrayContaining(['phrasebook', `lang:${lang}`, 'native:eng', 'no-generic-practice']));
      }
    });

    it('practises one phrase fully on every card, shared by all ways of saying it', () => {
      for (const c of cards) {
        expect(main(c)).toHaveLength(1);
        expect(concepts.get(main(c)[0])?.name).toMatch(new RegExp(`^${lang}: `));
      }
      // variants that say the same thing differently tell it apart
      const groups = Map.groupBy(cards, (c) => main(c)[0]);
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        expect(new Set(group.map((c) => c.context ?? '')).size).toBe(group.length);
      }
      expect([...groups.values()].some((g) => g.length >= 2)).toBe(true);
    });

    it('refers only to concepts it has, and links no concept to itself', () => {
      for (const c of cards) for (const id of Object.keys(c.concepts ?? {})) expect(concepts.has(id), id).toBe(true);
      for (const l of links) {
        expect(concepts.has(l.from!) && concepts.has(l.to!)).toBe(true);
        expect(l.from).not.toBe(l.to);
        expect(l.weight).toBeGreaterThan(0);
      }
    });

    it('links each phrase to what it does, and the language to its own concepts', () => {
      const out = (id: string) => links.filter((l) => l.from === id).map((l) => concepts.get(l.to!)!.name);
      for (const id of new Set(cards.flatMap(main))) expect(out(id).some((n) => n.startsWith('function: '))).toBe(true);
      for (const c of concepts.values()) if (c.name!.startsWith(`${lang}: `)) expect(out(c.id)).toContain(`lang: ${lang}`);
    });

    it('credits its source on every card taken from it', () => {
      const [source] = of('source@1');
      expect(source).toMatchObject({ license: 'CC-BY-SA-4.0', url: expect.stringMatching(/^https:\/\/en\.wikivoyage\.org\//) });
      const credited = cards.filter((c) => c.sources?.some((s) => s.to === source.id && s.label === 'adapted from'));
      expect(credited.length).toBeGreaterThan(cards.length / 2);
      for (const c of cards) for (const s of c.sources ?? []) expect(s.to).toBe(source.id);
      expect(readFileSync(join(decksDir, deck, 'LICENSE.md'), 'utf8')).toContain('CC BY-SA 4.0');
    });
  });
}

describe('the phrase decks together', () => {
  it('meet in the concepts no language owns', () => {
    const names = readdirSync(decksDir).map((deck) => {
      const dir = join(decksDir, deck, 'notes');
      return new Set(readdirSync(dir).map((f) => parse(readFileSync(join(dir, f), 'utf8')) as Yml).filter((y) => y.gestalt === 'concept@2').map((c) => c.id));
    });
    const shared = [...names[0]].filter((id) => names.slice(1).every((n) => n.has(id)));
    expect(shared.length).toBeGreaterThan(5);
  });
});
