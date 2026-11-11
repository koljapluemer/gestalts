import { describe, expect, it } from 'vitest';
import { BIB_HEADER, renderBibtex } from './bibtex-export';
import { bibtexName, decodeLatex, parseBibtex } from './bibtex-import';
import { ValidationError, normalise, splitName, uniqueKey, type Bib } from './fields';
import { compare, eprintKey, families, fold, isbnKey, doiKey, match, titleSimilarity, titleWords, urlKey } from './match';
import { mergeSource } from './merge';

describe('reading BibTeX', () => {
  it('maps legacy fields, decodes LaTeX and splits names', () => {
    const [s] = parseBibtex(String.raw`@article{Foo:2020,
      author={M{\"u}ller, Hans and {Some Corp} and van der Berg, Jan},
      title={A {T}itle}, journal={J}, year=2020, month=jan, volume={3}, weird={x}}`);
    expect(s).toEqual({
      key: 'Foo:2020', entrytype: 'article', title: 'A Title', journaltitle: 'J', date: '2020-01', volume: 3,
      author: ['Müller, Hans', 'Some Corp', 'van der Berg, Jan'],
    });
    normalise(s);
  });

  it('maps legacy types and a howpublished url', () => {
    const [a, b, c] = parseBibtex(`@phdthesis{t, author={X, Y}, school={U}, year=2001}
      @conference{c, title={C}}
      @misc{m, howpublished={\\url{http://a.b/c}}}`);
    expect([a.entrytype, a.type, a.institution]).toEqual(['thesis', 'phdthesis', ['U']]);
    expect(b.entrytype).toBe('inproceedings');
    expect(c.url).toBe('http://a.b/c');
    for (const s of [a, b, c]) normalise(s);
  });

  it('expands strings and joins, skips comments, and survives a broken entry', () => {
    const out = parseBibtex(`@string{acm = "ACM"}
      @comment{ignore {this} }
      @book{broken, title = {never closed
      @book(b, publisher = acm # { Press}, title = "Q{"}uote", pages = {1--2}, doi = {https://doi.org/10.1/X_y})`);
    expect(out.at(-1)).toEqual({ key: 'b', entrytype: 'book', publisher: ['ACM Press'], title: 'Q"uote', pages: '1--2', doi: 'https://doi.org/10.1/X_y' });
  });

  it('says when there is nothing', () => {
    expect(() => parseBibtex('just some text')).toThrow();
  });

  it('decodes common LaTeX', () => {
    expect(decodeLatex(String.raw`G{\"o}del, \'{E}cole, \c{c}a, \v Sk, {\ss}, {\o}, na\"{\i}ve, \emph{x}, A--B---C, 50\%, R\&D, a~b, \{x\}, \textasciitilde{}`))
      .toBe('Gödel, École, ça, Šk, ß, ø, naïve, x, A–B—C, 50%, R&D, a b, {x}, ~');
  });

  it('reads names the way BibTeX does', () => {
    expect(bibtexName('Donald E. Knuth')).toBe('Knuth, Donald E.');
    expect(bibtexName('Ludwig van Beethoven')).toBe('van Beethoven, Ludwig');
    expect(bibtexName('Doe, Jr., Jane')).toBe('Doe, Jr., Jane');
    expect(bibtexName('{World Health Organization}')).toBe('World Health Organization');
    expect(bibtexName('others')).toBe('others');
  });
});

describe('the model', () => {
  it('splits names', () => {
    expect(splitName('van Rossum, Guido')).toEqual({ family: 'Rossum', given: 'Guido', prefix: 'van' });
    expect(splitName('ACM')).toEqual({ literal: 'ACM' });
    expect(() => splitName('a, b, c, d')).toThrow(ValidationError);
  });

  it('normalises: keys checked, unknowns refused, identifiers in their kept form', () => {
    expect(normalise({ key: 'k', title: ' T ', doi: 'https://doi.org/10.1/AB', isbn: '0-465-02656-7', volume: '3', author: [' Doe,  Jane '] }))
      .toEqual({ key: 'k', entrytype: 'misc', title: 'T', author: ['Doe, Jane'], volume: 3, doi: '10.1/ab', isbn: '9780465026562' });
    expect(() => normalise({ key: 'a b' })).toThrow(ValidationError);
    expect(() => normalise({ key: 'k', journal: 'x' })).toThrow(/unknown field/);
    expect(() => normalise({ key: 'k', date: 'May 2020' })).toThrow(/date/);
    expect(() => normalise({ key: 'k', isbn: '12' })).toThrow(/isbn/);
  });

  it('finds a free key', () => {
    const taken = new Set(['k', 'k-2']);
    expect(uniqueKey('k', (x) => taken.has(x))).toBe('k-3');
  });
});

const GEB = { title: 'Gödel, Escher, Bach: An Eternal Golden Braid', author: ['Hofstadter, Douglas R.'], date: '1979', isbn: '0-465-02656-7' };
const level = (entry: object, other: object = GEB) => compare(entry, other)?.[0];

describe('matching', () => {
  it('normalises identifiers', () => {
    expect(doiKey('https://doi.org/10.1000/ABC')).toBe('10.1000/abc');
    expect(doiKey('doi:10.1000/abc')).toBe('10.1000/abc');
    expect(isbnKey('0-465-02656-7')).toBe(isbnKey('978-0-465-02656-2'));
    expect(isbnKey('12')).toBe('');
    expect(eprintKey({ eprint: '2101.00001v2', eprinttype: 'arXiv' })).toBe(eprintKey({ eprint: 'arXiv:2101.00001' }));
    expect(urlKey('https://www.example.org/a/#x')).toBe(urlKey('http://example.org/a'));
    expect(fold('Gödel,  ESCHER!')).toBe('godel escher');
  });

  it('takes family names', () => {
    expect(families({ author: ['van Beethoven, Ludwig', 'others', 'World Health Organization'] })).toEqual(['beethoven', 'organization']);
    expect(families({ editor: ['Müller, Hans'] })).toEqual(['muller']);
  });

  it('lets an identifier decide', () => {
    expect(level({ title: 'Something else entirely', isbn: '9780465026562' })).toBe('same');
    expect(level({ title: 'x', doi: '10.1/a' }, { title: 'y', doi: 'https://doi.org/10.1/A' })).toBe('same');
  });

  it('allows shortened titles, and missing fields count neither way', () => {
    expect(titleSimilarity('Gödel, Escher, Bach', GEB.title)).toBeGreaterThanOrEqual(0.9);
    expect(level({ title: 'Godel Escher Bach', author: ['Hofstadter, D.'], date: '1999' })).toBe('possible');
    expect(level({ title: 'Gödel, Escher, Bach', author: ['Hofstadter, Douglas', 'others'], date: '1980' })).toBe('likely');
    expect(level({ title: 'Gödel, Escher, Bach: an eternal golden braid' })).toBe('likely');
    expect(level({ title: 'GÖDEL, ESCHER, BACH: An Eternal Golden Braid', author: ['Hofstadter, D'], date: '1979' })).toBe('same');
  });

  it('caps a conflicting identifier, and matches by URL', () => {
    expect(level({ title: GEB.title, author: ['Hofstadter, D'], date: '1979', isbn: '9780140179972' })).toBe('possible');
    expect(level({ title: 'Totally different', url: 'http://example.org' }, { title: 'Home', url: 'https://www.example.org/' })).toBe('likely');
  });

  it('ignores the unrelated', () => {
    expect(compare({ title: 'Attention Is All You Need', author: ['Vaswani, Ashish'], date: '2017' }, GEB)).toBeUndefined();
    expect(compare({ title: '' }, GEB)).toBeUndefined();
  });

  it('orders and limits', () => {
    const others = [{ ...GEB, id: 'a', isbn: undefined, title: 'Gödel, Escher, Bach' }, { id: 'b', title: 'Unrelated' }, { ...GEB, id: 'geb' }];
    const found = match({ title: GEB.title, isbn: GEB.isbn }, others);
    expect(found.map((f) => f.source.id)).toEqual(['geb', 'a']);
    expect(found[0]).toMatchObject({ level: 'same', reasons: ['ISBN'] });
    expect(match({ title: 'x' }, [...others, ...others], 1)).toEqual([]);
  });

  it('picks title words to search by', () => {
    expect(titleWords('The Art of Computer Programming: Volume 1')).toEqual(['programming', 'computer', 'art']);
  });
});

describe('merging', () => {
  const current: Bib = { key: 'mine', entrytype: 'misc', title: 'T', author: ['Doe, Jane'], date: '2020' };
  const incoming: Bib = { key: 'doe2020t', entrytype: 'article', title: 'T', author: ['Doe, Jane', 'Roe, Rick'], date: '2020', journaltitle: 'J' };

  it('fills what is missing and holds back what differs', () => {
    const r = mergeSource(current, incoming);
    expect(r.filled).toEqual(['entrytype', 'journaltitle']);
    expect(r.conflicts.map((c) => c.field)).toEqual(['key', 'author']);
    expect(r.value).toEqual({ ...current, entrytype: 'article', journaltitle: 'J' });
  });

  it('replaces what is taken', () => {
    const r = mergeSource(current, incoming, ['author']);
    expect(r.value.author).toEqual(['Doe, Jane', 'Roe, Rick']);
    expect(r.value.key).toBe('mine');
    expect(r.conflicts.map((c) => c.field)).toEqual(['key']);
  });

  it('never takes misc over a real type', () => {
    expect(mergeSource({ key: 'k', entrytype: 'book' }, { key: 'k', entrytype: 'misc' }).value.entrytype).toBe('book');
  });
});

describe('writing BibTeX', () => {
  const source: Bib = {
    key: 'doe2020', entrytype: 'article', title: 'R&D at 50% — Müller',
    author: ['Doe, Jr., Jane', 'van Beethoven, Ludwig', 'World Health Organization'],
    journaltitle: 'Nature', volume: 3, date: '2020-05', location: ['Berlin', 'Rock and Roll'], url: 'https://x.org/a_b',
  };

  it('escapes, protects and round-trips', () => {
    const text = renderBibtex([source]);
    expect(text.startsWith(BIB_HEADER)).toBe(true);
    expect(text).toContain('title = {R\\&D at 50\\% — Müller}');
    expect(text).toContain('url = {https://x.org/a_b}');
    expect(text).toContain('author = {Doe, Jr., Jane and van Beethoven, Ludwig and {World Health Organization}}');
    expect(text).toContain('location = {Berlin and {Rock and Roll}}');
    expect(parseBibtex(text)).toEqual([source]);
  });

  it('sorts by key', () => {
    const text = renderBibtex([{ key: 'b', entrytype: 'misc' }, { key: 'a', entrytype: 'book' }]);
    expect(text.indexOf('@book{a')).toBeLessThan(text.indexOf('@misc{b'));
  });
});
