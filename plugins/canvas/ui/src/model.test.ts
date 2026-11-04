import { describe, expect, it } from 'vitest';
import { canvasReducer, fromWire, linkedNotes, nodeId, toWire, type CanvasDoc, type CanvasNode } from './model';

const text: CanvasNode = { id: 't', x: 0, y: 0, kind: 'text', text: 'hi' };
const note: CanvasNode = { id: 'n', x: 10, y: 20.5, kind: 'note', note: 'abc' };
const doc: CanvasDoc = { nodes: [text, note] };

describe('canvasReducer', () => {
  it('adds at the top, once per id', () => {
    expect(canvasReducer(doc, { type: 'add', node: { ...text, id: 'u' } }).nodes.map((n) => n.id)).toEqual(['t', 'n', 'u']);
    expect(canvasReducer(doc, { type: 'add', node: { ...note, id: 't' } })).toBe(doc);
  });

  it('moves, sets text and converts in place, keeping id and position', () => {
    expect(canvasReducer(doc, { type: 'move', id: 'n', x: 1, y: 2 }).nodes[1]).toEqual({ ...note, x: 1, y: 2 });
    expect(canvasReducer(doc, { type: 'setText', id: 't', text: 'yo' }).nodes[0]).toEqual({ ...text, text: 'yo' });
    expect(canvasReducer(doc, { type: 'toText', id: 'n', text: 'body' }).nodes[1]).toEqual({ id: 'n', x: 10, y: 20.5, kind: 'text', text: 'body' });
    expect(canvasReducer(doc, { type: 'toNote', id: 't', note: 'new' }).nodes[0]).toEqual({ id: 't', x: 0, y: 0, kind: 'note', note: 'new' });
  });

  it('leaves the doc as it is for nothing to change and for unknown ids', () => {
    expect(canvasReducer(doc, { type: 'move', id: 't', x: 0, y: 0 })).toBe(doc);
    expect(canvasReducer(doc, { type: 'setText', id: 'n', text: 'x' })).toBe(doc);
    for (const action of [
      { type: 'move', id: 'gone', x: 1, y: 1 }, { type: 'setText', id: 'gone', text: 'x' }, { type: 'remove', id: 'gone' },
      { type: 'toText', id: 'gone', text: 'x' }, { type: 'toNote', id: 'gone', note: 'x' },
    ] as const) expect(canvasReducer(doc, action)).toBe(doc);
  });

  it('restores a removed node at its z-position, once', () => {
    const removed = canvasReducer(doc, { type: 'remove', id: 't' });
    expect(removed.nodes).toEqual([note]);
    const restored = canvasReducer(removed, { type: 'restore', node: text, index: 0 });
    expect(restored.nodes).toEqual(doc.nodes);
    expect(canvasReducer(restored, { type: 'restore', node: text, index: 0 })).toBe(restored);
    expect(canvasReducer(removed, { type: 'restore', node: text, index: 9 }).nodes.map((n) => n.id)).toEqual(['n', 't']);
  });
});

describe('wire format', () => {
  it('round-trips', () => {
    const wire = toWire(doc);
    expect(wire).toEqual([{ id: 't', x: 0, y: 0, text: 'hi' }, { id: 'n', x: 10, y: 20.5, note: 'abc' }]);
    expect(fromWire(wire)).toEqual({ doc, problems: [] });
    expect(linkedNotes(wire)).toEqual(['abc']);
  });

  it('reports invalid nodes instead of dropping them quietly', () => {
    const { doc: read, problems } = fromWire([{ id: 'a', x: 'left', y: 0, text: 'x' }, { id: 'b', x: 0, y: 0 }, 7, { id: 'c', x: 0, y: 0, note: 'n' }]);
    expect(read.nodes.map((n) => n.id)).toEqual(['c']);
    expect(problems).toHaveLength(3);
    expect(fromWire('nope').problems).toEqual(['`nodes` is not a list']);
  });

  it('makes ids not taken', () => {
    expect(nodeId(doc)).toMatch(/^[a-z0-9]{8}$/);
  });
});
