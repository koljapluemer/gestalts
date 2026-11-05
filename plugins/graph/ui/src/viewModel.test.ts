import { describe, expect, it } from 'vitest';
import type { IndexedNote } from '@gestalts/sdk';
import { EMPTY_LAYOUT } from './layout';
import { buildView, type ViewCallbacks } from './viewModel';
import type { NoteGraph } from './graph';

const note = (key: string): IndexedNote => ({ key, id: key, raw: '', value: { id: key }, parse_error: null, gestalts: [], lints: [] });
const noop = () => {};
const callbacks = new Proxy({}, { get: () => noop }) as unknown as ViewCallbacks;

describe('buildView', () => {
  const graph = { nodes: [{ key: 'a' }, { key: 'b' }], edges: [], warnings: [] } as unknown as NoteGraph;
  const notes = new Map([['a', note('a')], ['b', note('b')]]);
  const cards = (key: string | null) => buildView(graph, notes, EMPTY_LAYOUT, new Map(), key ? { type: 'edit', key } : { type: 'idle' }, null, callbacks).nodes;

  it('shows the card in edit as editing, not draggable and above the others', () => {
    const [a, b] = cards('a');
    expect(a).toMatchObject({ draggable: false, zIndex: 1000, data: { editing: true } });
    expect(b).toMatchObject({ draggable: true, data: { editing: false } });
    expect(b.zIndex).toBeUndefined();
  });

  it('has no card in edit while idle', () => {
    expect(cards(null).map((n) => 'editing' in n.data && n.data.editing)).toEqual([false, false]);
  });
});
