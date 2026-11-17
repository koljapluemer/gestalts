import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { keystrokes, MARK_KEYS, markShares, marksOf } from './tools/script';

type Yml = {
  id: string; gestalt: string; name?: string; members?: string[]; model?: string; text?: string; gloss?: string;
  keystrokes?: { telex: string; vni: string }; marks?: { at: number; mark: string; key: string }[];
  concepts?: Record<string, number>; responses?: Record<string, { label: string; concepts: Record<string, number> }>;
  from?: string; to?: string; weight?: number; kind?: string; source?: string; tags?: string[]; in?: string;
};

const read = (dir: string) => readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')] as const);
const files = read(join(import.meta.dirname, 'decks/vietnamese-typing/notes'));
const ymls = files.map(([, t]) => parse(t) as Yml);
const of = (g: string) => ymls.filter((y) => y.gestalt === g);
const byId = new Map(ymls.map((y) => [y.id, y]));
// the phrasebook's deck, read as data (a plugin's files import no other plugin)
const phrasebook = new Map(read(join(import.meta.dirname, '../phrasebook/decks/vietnamese-for-english-speakers/notes')));
const words = JSON.parse(readFileSync(join(import.meta.dirname, 'tools/data/vie.json'), 'utf8')) as Record<string, string>;
const pairs = JSON.parse(readFileSync(join(import.meta.dirname, 'tools/data/phrasebook.json'), 'utf8')) as [string, string][];

const conceptId = (name: string) => `concept-${createHash('sha256').update(name).digest('hex').slice(0, 16)}`;
const LANGUAGE = conceptId('lang: vie');
const SCRIPT = conceptId('vie: script');
const concepts = [...of('concept@2'), ...of('concept@3')];
const links = of('concept-link@1');
const linked = (from: string, to: string) => links.find((l) => l.from === from && l.to === to);

describe('the vietnamese-typing deck', () => {
  it('lists everything in its deck yml, each named after its id', () => {
    for (const [f, t] of files) expect((parse(t) as Yml).id).toBe(f.replace(/\.yml$/, ''));
    const d = of('deck@1')[0];
    expect(new Set(d.members)).toEqual(new Set(ymls.filter((y) => y !== d).map((y) => y.id)));
  });

  it('names every concept by the shared rule', () => {
    for (const c of concepts) expect(c.id).toBe(conceptId(c.name!));
  });

  it('has a word for every entry, practising its word concept and its marks', () => {
    const typed = of('typing-word@1');
    expect(typed.map((w) => w.text).sort()).toEqual(Object.keys(words).sort());
    for (const w of typed) {
      const text = w.text!;
      expect(w.gloss).toBe(words[text]);
      expect(byId.get(w.model!)?.gestalt).toBe('item-model@1');
      expect(w.keystrokes).toEqual({ telex: keystrokes(text, 'telex'), vni: keystrokes(text, 'vni') });
      expect(w.marks).toEqual(marksOf(text));
      const expected = { [conceptId(`vie:${text}`)]: 0.2, ...Object.fromEntries([...markShares(text)].map(([k, s]) => [conceptId(`vie-script: ${k}`), s])) };
      expect(w.concepts).toEqual(expected);
      for (const c of Object.keys(w.concepts!)) expect(byId.get(c)?.gestalt, text).toBe('concept@3');
      expect(w.tags).toContain('vietnamese-typing-practice');
    }
  });

  it('tells each mark apart as a response of its own', () => {
    const [model] = of('item-model@1');
    expect(Object.keys(model.responses!)).toEqual([...MARK_KEYS]);
    for (const k of MARK_KEYS) expect(model.responses![k].concepts).toEqual({ [conceptId(`vie-script: ${k}`)]: 1 });
  });

  it('has every word in the language and every mark in the script, linked to neither', () => {
    expect(byId.get(SCRIPT)?.gestalt).toBe('concept@2');
    for (const c of concepts) {
      // words are `vie:<word>`; `vie: <intent>` is the phrasebook's
      if (/^vie:(?! )/.test(c.name!)) expect(c.in, c.name).toBe(LANGUAGE);
      if (c.name!.startsWith('vie-script: ')) expect(c.in, c.name).toBe(SCRIPT);
    }
    for (const l of links) expect(l.kind).not.toBe('part-of');
  });

  it('holds the phrasebook concepts it links to as the phrasebook does, linked both ways to their word', () => {
    for (const name of ['lang: vie', ...pairs.map(([intent]) => intent)]) {
      const f = `${conceptId(name)}.yml`;
      expect(files.find(([g]) => g === f)?.[1], name).toBe(phrasebook.get(f));
    }
    for (const [intent, word] of pairs) {
      expect(linked(conceptId(intent), conceptId(`vie:${word}`))?.weight).toBe(0.5);
      expect(linked(conceptId(`vie:${word}`), conceptId(intent))?.weight).toBe(0.1);
    }
    for (const l of links) expect(l.source).toBe('vietnamese-typing-practice/vietnamese-typing');
  });
});
