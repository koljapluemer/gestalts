import { describe, expect, it, vi } from 'vitest';
import type { Delta, Item, JsonMap } from '@gestalts/view';

vi.mock('@gestalts/client', () => ({ stableId: () => 's', stateId: () => 't', contentHash: () => 'h' }));
const { AccessError, Bridge } = await import('./bridge');

const env = { setState: () => {}, setTitle: () => {}, setParams: () => {}, openView: () => false };

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

  it('reaches only declared hosts, over plain https, and only where the app can', async () => {
    const seen: string[] = [];
    const reply = { status: 200, contentType: 'text/plain', body: new Uint8Array() };
    const withNet = { ...env, net: async (r: { url: string }) => { seen.push(r.url); return reply; }, capabilities: async () => ({ net: true, llm: true, backend: true }) };
    const bridge = new Bridge({} as never, { reads: [], writes: [], network: ['www.youtube.com'] }, withNet, () => {});
    await expect(bridge.handle({ op: 'net', request: { url: 'https://www.youtube.com/watch?v=x' } })).resolves.toBe(reply);
    for (const url of ['https://youtube.com/', 'http://www.youtube.com/', 'https://www.youtube.com:8443/', 'https://u:p@www.youtube.com/', 'nonsense']) {
      await expect(bridge.handle({ op: 'net', request: { url } })).rejects.toBeInstanceOf(AccessError);
    }
    expect(seen).toEqual(['https://www.youtube.com/watch?v=x']);
    await expect(bridge.handle({ op: 'capabilities' })).resolves.toEqual({ net: true, llm: false, backend: false });
    const offline = new Bridge({} as never, { reads: [], writes: [], network: ['www.youtube.com'] }, env, () => {});
    await expect(offline.handle({ op: 'net', request: { url: 'https://www.youtube.com/' } })).rejects.toBeInstanceOf(AccessError);
  });

  it('asks an LLM only for a view that declares it', async () => {
    const answer = { text: '{}', provider: 'gemini', model: 'm' };
    const withLlm = { ...env, llm: async () => answer };
    const declared = new Bridge({} as never, { reads: [], writes: [], llm: true }, withLlm, () => {});
    await expect(declared.handle({ op: 'llm', request: { prompt: 'hi' } })).resolves.toBe(answer);
    const undeclared = new Bridge({} as never, { reads: [], writes: [] }, withLlm, () => {});
    await expect(undeclared.handle({ op: 'llm', request: { prompt: 'hi' } })).rejects.toBeInstanceOf(AccessError);
  });

  it('says an optional backend is there only when the app wired it and it runs', async () => {
    const up = async () => ({ net: true, llm: false, backend: true });
    const reply = { status: 200, contentType: 'application/json', body: new Uint8Array() };
    const wired = new Bridge({} as never, { reads: [], writes: [] }, { ...env, capabilities: up, service: async () => reply }, () => {});
    await expect(wired.handle({ op: 'capabilities' })).resolves.toMatchObject({ backend: true });
    const unwired = new Bridge({} as never, { reads: [], writes: [] }, { ...env, capabilities: up }, () => {});
    await expect(unwired.handle({ op: 'capabilities' })).resolves.toMatchObject({ backend: false });
    await expect(unwired.handle({ op: 'service', path: '/x', method: 'POST' })).rejects.toBeInstanceOf(AccessError);
  });

  it('forwards deltas under its own numbering and stops everything when the view goes', async () => {
    const { bridge, stops, out, fire } = setup();
    const { sub } = await bridge.handle({ op: 'subscribe', query: { gestalt: 'note@1' } });
    fire({ sub: 999, upsert: [], remove: [], order: [], next: null });
    expect(out[0].sub).toBe(sub);
    bridge.close();
    expect(stops).toHaveLength(1);
  });

  it('keeps where a view put itself only as a map of strings, and says whether another view showed', async () => {
    const moves: Record<string, string>[] = [];
    const opened: string[] = [];
    const withTabs = { ...env, setParams: (p: Record<string, string>) => moves.push(p), openView: (v: string) => { opened.push(v); return v === 'note-crud'; } };
    const bridge = new Bridge({} as never, { reads: [], writes: [] }, withTabs, () => {});
    await bridge.handle({ op: 'setParams', params: { note: 'n' } });
    await expect(bridge.handle({ op: 'setParams', params: { note: 3 } as never })).rejects.toBeInstanceOf(AccessError);
    await expect(bridge.handle({ op: 'setParams', params: null as never })).rejects.toBeInstanceOf(AccessError);
    expect(moves).toEqual([{ note: 'n' }]);
    await expect(bridge.handle({ op: 'openView', view: 'note-crud', params: { note: 'n' } })).resolves.toBe(true);
    await expect(bridge.handle({ op: 'openView', view: 'elsewhere' })).resolves.toBe(false);
    await expect(bridge.handle({ op: 'openView', view: 'note-crud', params: ['x'] as never })).rejects.toBeInstanceOf(AccessError);
    expect(opened).toEqual(['note-crud', 'elsewhere']);
  });
});
