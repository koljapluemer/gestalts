import { describe, expect, it } from 'vitest';
import { gistMarkdown, noteGist, noteLine, plainLine, type GistPart } from './gist';

const kinds = (n: Parameters<typeof noteGist>[0], o?: Parameters<typeof noteGist>[1], p?: GistPart[]) => noteGist(n, o, p).map((b) => b.kind);

const QUOTE: GistPart = {
  keys: ['main', 'attribution'],
  blocks: (n) => [{ kind: 'quote', markdown: `> ${String(n.main)}${n.attribution ? `\n\n— ${String(n.attribution)}` : ''}` }],
  line: (n) => (typeof n.main === 'string' ? n.main : undefined),
};

describe('noteGist', () => {
  it('reads whatever the note has, whole and in order', () => {
    expect(gistMarkdown(noteGist({ title: 'A title', main: 'line one\nline two', extra: 'more' })))
      .toBe('## A title\n\nline one\nline two\n\nmore');
    expect(kinds({ main: 'only text' })).toEqual(['main']);
    expect(kinds({ title: 'T', extra: 'e' })).toEqual(['title', 'extra']);
    expect(kinds({ extra: 'e' })).toEqual(['extra']);
    expect(kinds({ title: '  ' , main: '' })).toEqual([]);
  });

  it('leaves out tasks, extra or the title when asked', () => {
    const n = { title: 'T', tasks: 'todo', main: 'm', extra: 'e' };
    expect(kinds(n)).toEqual(['title', 'tasks', 'main', 'extra']);
    expect(kinds(n, { tasks: false, extra: false, title: false })).toEqual(['main']);
  });

  it('shows a flashcard front and back with a rule between', () => {
    expect(noteGist({ front: 'Q', back: 'A' })).toEqual([{ kind: 'card', markdown: 'Q\n\n---\n\nA' }]);
  });

  it('shows each card, a link and a canvas’s text', () => {
    expect(noteGist({ cards: [{ id: '1', front: 'F1', back: 'B1' }, { id: '2', front: 'F2', back: 'B2' }] }).map((b) => b.markdown))
      .toEqual(['F1\n\n---\n\nB1', 'F2\n\n---\n\nB2']);
    expect(noteGist({ url: 'https://example.com/a/' })).toEqual([{ kind: 'link', markdown: '[example.com/a](https://example.com/a/)' }]);
    expect(gistMarkdown(noteGist({ canvas: { nodes: [{ id: 'a', x: 0, y: 0, text: 'one' }, { id: 'b', x: 0, y: 0, note: 'k' }, { id: 'c', x: 0, y: 0, text: 'two' }] } })))
      .toBe('one\n\n---\n\ntwo');
  });

  it('lets a lens part show fields its way, once', () => {
    expect(noteGist({ main: 'To be.', attribution: 'H.' }, {}, [QUOTE])).toEqual([{ kind: 'quote', markdown: '> To be.\n\n— H.' }]);
  });

  it('keeps to the fields `only` lets through', () => {
    const only = (k: string) => ['title', 'main', 'tasks', 'extra', 'cards'].includes(k);
    expect(kinds({ title: 'T', main: 'm', front: 'f', back: 'b' }, { title: false, only })).toEqual(['main']);
    // the quote part needs `attribution`, a property there: the plain text shows instead
    expect(kinds({ main: 'To be.', attribution: 'H.' }, { only }, [QUOTE])).toEqual(['main']);
  });
});

describe('noteLine', () => {
  it('prefers the title, then the text, then other parts', () => {
    expect(noteLine({ title: 'T', main: 'm' })).toBe('T');
    expect(noteLine({ main: '# **Big** idea\nmore' })).toBe('Big idea');
    expect(noteLine({ front: 'Q?', back: 'A' })).toBe('Q?');
    expect(noteLine({ url: 'https://example.com/x' })).toBe('example.com/x');
    expect(noteLine({ extra: 'e' })).toBe('e');
    expect(noteLine({ main: 'quoted', attribution: 'H.' }, [QUOTE])).toBe('quoted');
  });

  it('is empty rather than YAML when there is nothing to name it by', () => {
    expect(noteLine({ tags: ['x'] })).toBe('');
    expect(noteLine({ canvas: { nodes: [] } })).toBe('');
  });
});

describe('plainLine', () => {
  it('drops Markdown syntax', () => {
    expect(plainLine('- [ ] see [[abc|Alice]] and [docs](https://x) `code`')).toBe('see Alice and docs code');
  });
});
