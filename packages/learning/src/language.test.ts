import { describe, expect, it } from 'vitest';
import { iso639_3 } from './language';

describe('iso639_3', () => {
  it('gives the three-letter code of a two-letter one', () => {
    expect(iso639_3('vi')).toBe('vie');
    expect(iso639_3('de')).toBe('deu');
    expect(iso639_3('EN')).toBe('eng');
  });

  it('keeps only the language of a longer tag', () => {
    expect(iso639_3('pt-BR')).toBe('por');
    expect(iso639_3('zh-Hans')).toBe('zho');
  });

  it('reads deprecated codes as their current ones', () => {
    expect(iso639_3('iw')).toBe('heb');
    expect(iso639_3('in')).toBe('ind');
  });

  it('keeps a code that is three letters already', () => {
    expect(iso639_3('fil')).toBe('fil');
    expect(iso639_3('grc')).toBe('grc');
    expect(iso639_3('gsw-CH')).toBe('gsw');
  });

  it('gives the first subtag of a tag that is not well-formed', () => {
    expect(iso639_3('x_y z')).toBe('x');
  });
});
