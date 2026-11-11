import { describe, expect, it } from 'vitest';
import type { Belief, Item, JsonMap } from '@gestalts/view';
import { fsrsStates } from './learning';
import { lessonPlan, mainConcept, rankNew, sideStrength, variantGroups } from './variants';

const now = new Date('2026-11-11T12:00:00Z');
const due = (target: string): Item => {
  const value: JsonMap = { id: target, gestalt: 'fsrs-data@1', target, last_rating: 3, card: { dueAt: '2026-11-01T00:00:00Z' } };
  return { id: target, gestalt: 'fsrs-data@1', value };
};
const belief = (concept: string, p: number): Belief => ({ concept, mean: Math.log(p / (1 - p)), sd: 1, p, evidence: 1 });
const beliefs = (...bs: Belief[]) => new Map(bs.map((b) => [b.concept, b]));

// three ways to ask how someone is, and one way to say thank you
const anh = { id: 'anh', concepts: { ask: 1, 'to-anh': 0.5, 'a': 0.3 } };
const chi = { id: 'chi', concepts: { ask: 1, 'to-chi': 0.5, 'a': 0.3 } };
const em = { id: 'em', concepts: { ask: 1, 'to-em': 0.5 } };
const thanks = { id: 'thanks', concepts: { thank: 1 } };
const all = [anh, chi, em, thanks];

describe('variants', () => {
  it('are grouped by what they practise most', () => {
    expect(mainConcept({ a: 0.2, b: 1, c: 1 })).toBe('b');
    expect(mainConcept({})).toBeUndefined();
    expect([...variantGroups(all).entries()].map(([k, v]) => [k, v.map((i) => i.id)])).toEqual([['ask', ['anh', 'chi', 'em']], ['thank', ['thanks']]]);
  });

  it('tell apart by the rest of what they practise', () => {
    expect(sideStrength(anh, beliefs(belief('to-anh', 0.9), belief('a', 0.9)))).toBeCloseTo(0.9);
    expect(sideStrength(thanks, beliefs())).toBeUndefined();
  });

  it('come up one per group in a lesson, the weakest one', () => {
    const states = fsrsStates(all.map((i) => due(i.id)));
    const known = beliefs(belief('to-anh', 0.9), belief('to-chi', 0.2), belief('to-em', 0.8), belief('a', 0.6));
    const plan = lessonPlan(all, states, known, now, { random: () => 0.5 });
    expect(plan.map((i) => i.id).sort()).toEqual(['chi', 'thanks']);
    expect(lessonPlan(all, states, known, now, { max: 1, random: () => 0.5 })).toHaveLength(1);
  });

  it('only come up when due', () => {
    expect(lessonPlan(all, fsrsStates([due('em')]), beliefs(), now).map((i) => i.id)).toEqual(['em']);
  });

  it('new ones that are mostly known come first, saying why', () => {
    const states = fsrsStates([due('anh')]);
    const known = beliefs(belief('ask', 0.85), belief('to-chi', 0.3), belief('to-em', 0.7));
    const ranked = rankNew(all, states, known);
    expect(ranked.map((r) => r.item.id)).toEqual(['em', 'chi', 'thanks']);
    expect(ranked[0].strong).toEqual(['ask', 'to-em']);
    expect(ranked[2].strong).toEqual([]);
  });
});
