import { describe, expect, it } from 'vitest';
import { fsrsStates } from '@gestalts/learning';
import type { Item } from '@gestalts/view';
import { buildMetaSegments, conceptName, EXPOSURE_STRENGTH, glossPrompt, knownLanguages, languageFromInput, lookahead, parseGlosses, parseJson3, pickGloss, segmentAt, standing, videoIdFrom, withConcepts, type Gloss } from './view';

describe('YouTube input', () => {
  it('finds the video id in the usual links', () => {
    for (const url of ['https://www.youtube.com/watch?v=M7lc1UVf-VE&t=3', 'https://youtu.be/M7lc1UVf-VE', 'https://m.youtube.com/shorts/M7lc1UVf-VE', 'https://www.youtube.com/embed/M7lc1UVf-VE', 'M7lc1UVf-VE']) {
      expect(videoIdFrom(url)).toBe('M7lc1UVf-VE');
    }
    expect(videoIdFrom('https://vimeo.com/123')).toBeNull();
    expect(videoIdFrom('hello')).toBeNull();
  });

  it('reads json3 subtitles, skipping empty events', () => {
    const cues = parseJson3({ events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Hallo ' }, { utf8: 'Welt' }] }, { tStartMs: 3000 }, { tStartMs: 4000, segs: [{ utf8: '\n' }] }] });
    expect(cues).toEqual([{ start: 1, end: 3, text: 'Hallo Welt' }]);
  });
});

describe('segments', () => {
  const cue = (i: number, words: number) => ({ start: i, end: i + 1, text: Array.from({ length: words }, (_, w) => `w${i}_${w}`).join(' ') });

  it('joins cues into segments of about 12 to 25 words, in order and complete', () => {
    const cues = Array.from({ length: 20 }, (_, i) => cue(i, 5));
    const segs = buildMetaSegments(cues);
    expect(segs.length).toBeGreaterThan(1);
    for (const s of segs) expect(s.text.split(' ').length).toBeLessThanOrEqual(50);
    expect(segs.map((s) => s.text).join(' ')).toBe(cues.map((c) => c.text).join(' '));
  });

  it('looks a few segments ahead of playback', () => {
    const segs = [0, 10, 20, 30, 40, 50].map((s) => ({ start: s, end: s + 10, text: '' }));
    expect(lookahead(segs, 15)).toEqual([1, 2, 3, 4]);
    expect(lookahead(segs, 55)).toEqual([5]);
    expect(lookahead(segs, 99)).toEqual([]);
  });
});

describe('the card language', () => {
  const known = knownLanguages();

  it('offers every language the browser knows, not a chosen few', () => {
    expect(known.length).toBeGreaterThan(150);
    expect(known.find((l) => l.code === 'sw')?.name).toBe('Swahili');
  });

  it('takes a name or any well-formed code', () => {
    expect(languageFromInput('german', known)).toBe('de');
    expect(languageFromInput('gsw', known)).toBe('gsw');
    expect(languageFromInput('pt-br', known)).toBe('pt-BR');
    expect(languageFromInput('not a language!', known)).toBeNull();
    expect(languageFromInput('  ', known)).toBeNull();
  });
});

describe('glosses', () => {
  it('asks in the learner\'s languages, for flemmas', () => {
    const p = glossPrompt('Ich gehe nach Hause.', 'de', 'en');
    expect(p).toContain('English speaker');
    expect(p).toContain('German subtitle segment');
    expect(p).toContain('"flemma"');
  });

  it('keeps well-formed glosses and falls back to the surface for a missing flemma', () => {
    expect(parseGlosses('{"vocab":[{"surface":"gehe","flemma":"gehen","translation":"go"},{"surface":"Haus","translation":"house"},{"surface":"x"}]}'))
      .toEqual([{ surface: 'gehe', flemma: 'gehen', translation: 'go' }, { surface: 'Haus', flemma: 'Haus', translation: 'house' }]);
    expect(parseGlosses('{"vocab":{"gehe":"go"}}')).toBeNull();
    expect(parseGlosses('nope')).toBeNull();
  });
});

describe('what the learner knows', () => {
  const now = new Date('2026-11-10T12:00:00Z');
  const review = (target: string, stability: number, dueAt: string): Item => ({
    id: `r-${target}`, gestalt: 'fsrs-data@1',
    value: { id: `r-${target}`, gestalt: 'fsrs-data@1', target, model: 'FSRS-7', last_rating: 3, card: { dueAt, stability, difficulty: 5, state: 2, reps: 3, lapses: 0 } },
  });
  const states = fsrsStates([review('card-due', 3, '2026-11-09T00:00:00Z'), review('card-stable', 40, '2027-01-01T00:00:00Z'), review('card-later', 5, '2026-12-01T00:00:00Z')]);
  const cardOf = new Map([['c-due', 'card-due'], ['c-stable', 'card-stable'], ['c-later', 'card-later']]);

  it('hides words whose flashcard is well learned, and marks due ones', () => {
    expect(standing('c-stable', cardOf, states, now)).toBe('hidden');
    expect(standing('c-due', cardOf, states, now)).toBe('due');
    expect(standing('c-later', cardOf, states, now)).toBe('new');
    expect(standing('c-unknown', cardOf, states, now)).toBe('new');
    expect(standing(undefined, cardOf, states, now)).toBe('new');
  });

  it('picks due words first, never hidden ones or ones on screen', () => {
    const g = (surface: string): Gloss => ({ surface, flemma: surface, translation: surface });
    const of = { a: 'new', b: 'due', c: 'hidden', d: 'due' } as const;
    const st = (x: Gloss) => of[x.surface as keyof typeof of];
    expect(pickGloss([g('a'), g('b'), g('c')], new Set(), st, () => 0)?.surface).toBe('b');
    expect(pickGloss([g('a'), g('b'), g('c')], new Set(['b']), st, () => 0)?.surface).toBe('a');
    expect(pickGloss([g('c')], new Set(), st)).toBeNull();
  });

  it('names concepts per language, like the decks do', () => {
    expect(conceptName('de-DE', ' gehen ')).toBe('de:gehen');
  });
});

describe('a shown word', () => {
  it('is linked from the video at a small strength, keeping links it has', () => {
    const video = { id: 'v', gestalt: 'media-source@1', concepts: { a: 0.5 } };
    expect(withConcepts(video, ['a', 'b'])).toEqual({ id: 'v', gestalt: 'media-source@1', concepts: { a: 0.5, b: EXPOSURE_STRENGTH } });
    expect(withConcepts(video, ['a'])).toBeNull();
    expect(withConcepts({ id: 'v', gestalt: 'media-source@1' }, [])).toBeNull();
    expect(EXPOSURE_STRENGTH).toBe(0.05);
  });

  it('finds the segment playing', () => {
    const segs = [{ start: 0, end: 5, text: '', glosses: [] }, { start: 6, end: 9, text: '', glosses: [] }];
    expect(segmentAt(segs, 7)).toBe(1);
    expect(segmentAt(segs, 5.5)).toBe(-1);
  });
});
