import { describe, expect, it, vi } from 'vitest';
import type { Delta, Item, JsonMap } from '@gestalts/view';

vi.mock('@gestalts/client', () => ({ stableId: () => 's', stateId: () => 't', contentHash: () => 'h' }));
const { AccessError, Bridge } = await import('./bridge');

const env = { setState: () => {}, setTitle: () => {}, openView: () => {} };

function setup(existing: Item[] = []) {
  const stops: number[] = [];
  const store = new Map(existing.map((i) => [i.id, i]));
  let listener: ((d: Delta) => void) | undefined;
  const repo = {
    query: () => ({ items: [...store.values()], next: null }),
    live: (_q: unknown, f: (d: Delta) => void) => { listener = f; return { page: { items: [], next: null }, stop: () => stops.push(1) }; },
    get: (id: string) => store.get(id),
    put: async (value: JsonMap) => { const i = { id: String(value.id), gestalt: String(value.gestalt), value }; store.set(i.id, i); return i; },
    delete: async (id: string) => store.delete(id),
    readBlob: async () => new Uint8Array([1]),
    writeBlob: async () => {},
  };
  const out: Delta[] = [];
  const bridge = new Bridge(repo as never, { reads: ['note@1', 'concept@1'], writes: ['note@1'] }, env, (d) => out.push(d));
  return { bridge, stops, out, fire: (d: Delta) => listener?.(d), store };
}

const concept: Item = { id: 'c', gestalt: 'concept@1', value: { id: 'c', gestalt: 'concept@1', name: 'x' } };
const secret: Item = { id: 's', gestalt: 'deck@1', value: { id: 's', gestalt: 'deck@1', name: 'x', members: [] } };

describe('the bridge', () => {
  it('answers only for gestalts the view reads, and a query must name one', async () => {
    const { bridge } = setup();
    await expect(bridge.handle({ op: 'query', query: { gestalt: 'note@1' } })).resolves.toBeTruthy();
    await expect(bridge.handle({ op: 'query', query: {} })).rejects.toBeInstanceOf(AccessError);
    await expect(bridge.handle({ op: 'query', query: { gestalt: 'deck@1' } })).rejects.toBeInstanceOf(AccessError);
    await expect(bridge.handle({ op: 'subscribe', query: { gestalt: 'deck@1' } })).rejects.toBeInstanceOf(AccessError);
  });

  it('writes only gestalts the view writes', async () => {
    const { bridge, store } = setup();
    await bridge.handle({ op: 'put', value: { id: 'n', gestalt: 'note@1' } });
    expect(store.has('n')).toBe(true);
    await expect(bridge.handle({ op: 'put', value: { id: 'c2', gestalt: 'concept@1', name: 'x' } })).rejects.toBeInstanceOf(AccessError);
  });

  it("can't overwrite or delete a yml of a gestalt it doesn't write, under any disguise", async () => {
    const { bridge, store } = setup([concept, secret]);
    await expect(bridge.handle({ op: 'put', value: { id: 'c', gestalt: 'note@1' } })).rejects.toBeInstanceOf(AccessError);
    expect(store.get('c')?.gestalt).toBe('concept@1');
    await expect(bridge.handle({ op: 'delete', id: 'c' })).rejects.toBeInstanceOf(AccessError);
    await expect(bridge.handle({ op: 'delete', id: 's' })).rejects.toBeInstanceOf(AccessError);
    expect(store.size).toBe(2);
  });

  it('forwards deltas under its own numbering and stops everything when the view goes', async () => {
    const { bridge, stops, out, fire } = setup();
    const { sub } = await bridge.handle({ op: 'subscribe', query: { gestalt: 'note@1' } });
    fire({ sub: 999, upsert: [], remove: [], order: [], next: null });
    expect(out[0].sub).toBe(sub);
    bridge.close();
    expect(stops).toHaveLength(1);
  });
});
