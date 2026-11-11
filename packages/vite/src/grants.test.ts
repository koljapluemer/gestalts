import { describe, expect, it } from 'vitest';
import { grantsFor } from './grants';

const video = { id: 'video', permissions: ['same-origin'], npm: [] };
const phrases = { id: 'phrases', permissions: ['same-origin', 'microphone'], npm: [] };
const plain = { id: 'plain', npm: [] };

describe('grants', () => {
  it('gives what is granted and nothing else', () => {
    const g = grantsFor({ video: ['same-origin'], phrases: ['same-origin', 'microphone'] }, [video, phrases, plain]);
    expect(g.get('video')).toEqual(['same-origin']);
    expect(g.get('phrases')).toEqual(['same-origin', 'microphone']);
    expect(g.get('plain')).toEqual([]);
  });

  it('may grant less than asked', () => {
    expect(grantsFor({ phrases: ['same-origin'] }, [phrases]).get('phrases')).toEqual(['same-origin']);
    expect(grantsFor(undefined, [phrases]).get('phrases')).toEqual([]);
  });

  it('refuses what a distribution cannot give', () => {
    expect(() => grantsFor({ plain: ['same-origin'] }, [plain])).toThrow(/doesn't ask/);
    expect(() => grantsFor({ nobody: ['same-origin'] }, [plain])).toThrow(/no plugin/);
    expect(() => grantsFor({ phrases: ['microphone'] }, [phrases])).toThrow(/same-origin/);
    expect(() => grantsFor({ phrases: ['camera'] }, [phrases])).toThrow(/unknown/);
    expect(() => grantsFor({ video: ['same-origin'] }, [{ ...video, npm: ['left-pad'] }])).toThrow(/npm/);
  });

  it('refuses what a plugin cannot ask', () => {
    expect(() => grantsFor(undefined, [{ id: 'x', permissions: ['microphone'], npm: [] }])).toThrow(/same-origin/);
    expect(() => grantsFor(undefined, [{ id: 'x', permissions: ['camera'], npm: [] }])).toThrow(/unknown/);
  });
});
