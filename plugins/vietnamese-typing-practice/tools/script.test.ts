import { describe, expect, it } from 'vitest';
import { keystrokes, markShares, marksOf } from './script';

describe('keystrokes', () => {
  it('types the tone at the end of the vowel run, before a trailing consonant', () => {
    expect(keystrokes('tiếng', 'telex')).toBe('tieesng');
    expect(keystrokes('tiếng', 'vni')).toBe('tie61ng');
  });

  it('types shape marks at their letter', () => {
    expect(keystrokes('người', 'telex')).toBe('nguwowif');
    expect(keystrokes('người', 'vni')).toBe('ngu7o7i2');
    expect(keystrokes('tạm biệt', 'telex')).toBe('tajm bieejt');
    expect(keystrokes('ăn', 'vni')).toBe('a8n');
  });

  it('types đ, upper case too', () => {
    expect(keystrokes('đi', 'telex')).toBe('ddi');
    expect(keystrokes('Đi', 'telex')).toBe('DDi');
    expect(keystrokes('đi', 'vni')).toBe('d9i');
    expect(keystrokes('tiếng Việt', 'telex')).toBe('tieesng Vieejt');
    expect(keystrokes('Ơ', 'telex')).toBe('OW');
  });

  it('leaves a word without marks as it is', () => {
    expect(keystrokes('email', 'telex')).toBe('email');
    expect(keystrokes('xin chao', 'vni')).toBe('xin chao');
  });
});

describe('marks', () => {
  it('names each mark at its letter, shape before tone', () => {
    expect(marksOf('người').map((m) => [m.at, m.key])).toEqual([[2, 'ư'], [3, 'ơ'], [3, 'huyền']]);
    expect(marksOf('đỏ').map((m) => [m.at, m.key])).toEqual([[0, 'đ'], [1, 'hỏi']]);
    expect(marksOf('Việt').map((m) => m.key)).toEqual(['ê', 'nặng']);
    expect(marksOf('email')).toEqual([]);
  });

  it('gives what a typed letter must contain for the mark to be there', () => {
    for (const m of marksOf('người đỏ')) expect('người đỏ'[m.at].toLowerCase().normalize('NFD')).toContain(m.mark);
    const [shape, tone] = marksOf('ế');
    expect('ể'.normalize('NFD')).toContain(shape.mark);
    expect('ể'.normalize('NFD')).not.toContain(tone.mark);
  });

  it('shares a word between its marks', () => {
    expect(markShares('người')).toEqual(new Map([['ư', 0.333333], ['ơ', 0.333333], ['huyền', 0.333333]]));
    expect(markShares('xin chào')).toEqual(new Map([['huyền', 1]]));
    expect(markShares('email').size).toBe(0);
  });

  it('refuses text that is not NFC', () => {
    expect(() => marksOf('tiếng'.normalize('NFD'))).toThrow();
  });
});
