import { describe, expect, it } from 'vitest';
import type { IndexedNote, Json, RefsOf } from '@gestalts/sdk';
import { GraphView, MAX_DIRECT_RELATIONS, MAX_GRAPH_NODES, buildGraph, randomKey, readPins, relationsOf } from './graph';

const note = (key: string, value: Json, parseError = false): IndexedNote => ({
  key, id: key, raw: '', value: parseError ? null : value, parse_error: parseError ? { message: 'x', line: 1, column: 1 } : null, gestalts: [], lints: [],
});

// `[[x]]` as the only Markdown the tests need
const refsOf: RefsOf = (text) => [...text.matchAll(/(!?)\[\[([^\]|]+)/g)].map((m) => ({ target: m[2], embed: m[1] === '!' }));

const view = (notes: IndexedNote[]) => {
  const keys = new Set(notes.map((n) => n.key));
  return new GraphView(notes, (id) => (keys.has(id) ? id : undefined), refsOf);
};

const rel = (to: string, label?: string): Json => (label ? { to, label } : to);

describe('relationsOf', () => {
  it('lists explicit ones, then inline references not already related', () => {
    const n = note('a', { main: 'see [[b]] and [[c]] and [[a]]', relationships: [rel('b', 'part-of'), rel('d'), rel('d')] });
    const got = relationsOf(n, (id) => id, refsOf);
    expect(got).toEqual([
      { source: 'a', target: 'b', label: 'part-of', inline: false, via: 'b' },
      { source: 'a', target: 'd', label: null, inline: false, via: 'd' },
      { source: 'a', target: 'c', label: null, inline: true, via: 'c' },
    ]);
  });

  it('counts `inline`-labelled relationships as inline, once with the text', () => {
    const n = note('a', { main: '[[b]]', relationships: [rel('b', 'inline')] });
    expect(relationsOf(n, (id) => id, refsOf)).toEqual([{ source: 'a', target: 'b', label: null, inline: true, via: 'b' }]);
  });
});

describe('buildGraph', () => {
  // a -> b -> c -> d, e unrelated
  const chain = view([
    note('a', { relationships: [rel('b')] }),
    note('b', { relationships: [rel('c', 'next')] }),
    note('c', { relationships: [rel('d')] }),
    note('d', {}),
    note('e', {}),
  ]);

  it('shows the notes within each pin\'s depth, with the edges between them', () => {
    const g = buildGraph(chain, [{ key: 'a', depth: 2 }]);
    expect(g.nodes.map((n) => [n.key, n.depth])).toEqual([['a', 0], ['b', 1], ['c', 2]]);
    expect(g.edges.map((e) => `${e.source}>${e.target}`)).toEqual(['a>b', 'b>c']);
    expect(g.nodes.find((n) => n.key === 'c')?.hiddenNeighbors).toBe(1);
    expect(g.warnings).toEqual([]);
  });

  it('follows incoming relationships too, and takes the nearest pin\'s depth', () => {
    const g = buildGraph(chain, [{ key: 'd', depth: 1 }, { key: 'a', depth: 0 }]);
    expect(g.nodes.map((n) => [n.key, n.depth])).toEqual([['a', 0], ['d', 0], ['c', 1]]);
  });

  it('pins at depth 0 show only the note', () => {
    const g = buildGraph(chain, [{ key: 'b', depth: 0 }]);
    expect(g.nodes.map((n) => n.key)).toEqual(['b']);
    expect(g.nodes[0].hiddenNeighbors).toBe(2);
    expect(g.edges).toEqual([]);
  });

  it('leaves out pins of notes not in the graph', () => {
    expect(buildGraph(chain, [{ key: 'gone', depth: 2 }]).nodes).toEqual([]);
  });

  it('caps the relationships per note and the notes in all', () => {
    const many = Array.from({ length: MAX_DIRECT_RELATIONS + 5 }, (_, i) => note(`n${String(i).padStart(3, '0')}`, {}));
    const hub = note('hub', { relationships: many.map((n) => rel(n.key)) });
    const g = buildGraph(view([hub, ...many]), [{ key: 'hub', depth: 1 }]);
    expect(g.nodes).toHaveLength(MAX_DIRECT_RELATIONS + 1);
    expect(g.warnings).toHaveLength(1);

    const wide = Array.from({ length: MAX_GRAPH_NODES + 10 }, (_, i) => note(`w${i}`, {}));
    const pins = wide.map((n) => ({ key: n.key, depth: 0 }));
    // pins themselves aren't capped, only the notes they bring in
    expect(buildGraph(view(wide), pins).nodes).toHaveLength(MAX_GRAPH_NODES + 10);
  });

  it('leaves out notes whose YAML doesn\'t parse, and relationships to them', () => {
    const g = buildGraph(view([note('a', { relationships: [rel('b')] }), note('b', {}, true)]), [{ key: 'a', depth: 1 }]);
    expect(g.nodes.map((n) => n.key)).toEqual(['a']);
    expect(g.nodes[0].degree).toBe(0);
  });

  it('keeps both directions of a reciprocal pair', () => {
    const g = buildGraph(view([note('a', { relationships: [rel('b', 'x')] }), note('b', { relationships: [rel('a', 'y')] })]), [{ key: 'a', depth: 1 }]);
    expect(g.edges.map((e) => `${e.source}>${e.target}:${e.label}`).sort()).toEqual(['a>b:x', 'b>a:y']);
  });
});

describe('randomKey', () => {
  const v = view([note('a', { relationships: [rel('b')] }), note('b', {}), note('c', {})]);

  it('picks one not excluded, or only orphans', () => {
    expect(randomKey(v, ['a', 'b'], false)).toBe('c');
    expect(randomKey(v, [], true)).toBe('c');
    expect(randomKey(v, ['c'], true)).toBeNull();
  });
});

describe('readPins', () => {
  it('keeps the well-formed ones', () => {
    expect(readPins([{ key: 'a', depth: 1 }, { key: '', depth: 1 }, { key: 'b', depth: -1 }, { key: 'c', depth: 1.5 }, 'x', { key: 'd', depth: 0 }]))
      .toEqual([{ key: 'a', depth: 1 }, { key: 'd', depth: 0 }]);
    expect(readPins(undefined)).toEqual([]);
  });
});
