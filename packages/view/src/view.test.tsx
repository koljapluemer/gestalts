import { describe, expect, it } from 'vitest';
import { connect } from './connection';
import { fixtureHost } from './fixture';
import type { ToView } from './protocol';

const note = (id: string, extra = {}) => ({ id, gestalt: 'note@1', ...extra });

describe('fixture host', () => {
  it('answers queries in bounded pages', async () => {
    const h = fixtureHost(Array.from({ length: 5 }, (_, i) => note(`n${i}`)));
    const first = await h.call({ op: 'query', query: { gestalt: 'note@1', limit: 2 } });
    expect(first.items.map((i) => i.id)).toEqual(['n0', 'n1']);
    const second = await h.call({ op: 'query', query: { gestalt: 'note@1', limit: 2, cursor: first.next! } });
    expect(second.items.map((i) => i.id)).toEqual(['n2', 'n3']);
  });

  it('sends a live query its deltas', async () => {
    const h = fixtureHost([note('a')]);
    const { sub } = await h.call({ op: 'subscribe', query: { gestalt: 'note@1' } });
    const seen: string[][] = [];
    h.onDelta(sub, (d) => seen.push(d.order));
    await h.call({ op: 'put', value: note('b') });
    await h.call({ op: 'delete', id: 'a' });
    expect(seen).toEqual([['a', 'b'], ['b']]);
  });

  it('filters by tag and text', async () => {
    const h = fixtureHost([note('a', { tags: ['no-queue'] }), note('b', { main: 'Κιννάμωμον' })]);
    const none = await h.call({ op: 'query', query: { gestalt: 'note@1', tags: { none: ['no-queue'] } } });
    expect(none.items.map((i) => i.id)).toEqual(['b']);
    const text = await h.call({ op: 'query', query: { gestalt: 'note@1', text: 'κιννα' } });
    expect(text.items.map((i) => i.id)).toEqual(['b']);
  });
});

import { compile } from './compile';

describe('compile', () => {
  it('keeps ES imports and finds what comes from npm', () => {
    const r = compile("import { useQuery } from '@gestalts/view';\nimport confetti from 'canvas-confetti';\nexport default function V() { return <p>{String(useQuery)}{String(confetti)}</p>; }\n");
    expect(r.ok && r.npm).toEqual(['canvas-confetti']);
    expect(r.ok && r.js).toContain("from '@gestalts/view'");
  });

  it('refuses a local import, a missing default export and bad syntax', () => {
    expect(compile("import './x';\nexport default () => null;").ok).toBe(false);
    expect(compile('export const a = 1;').ok).toBe(false);
    expect(compile('export default (').ok).toBe(false);
  });
});

describe('where a view is', () => {
  it('hears each move, and the last one made before it listened', async () => {
    const { port1, port2 } = new MessageChannel();
    const host = connect(port1);
    const send = (m: ToView) => port2.postMessage(m);
    const tick = () => new Promise((r) => setTimeout(r, 0));
    send({ type: 'params', params: { note: 'a' } });
    send({ type: 'params', params: { note: 'b' } });
    await tick();
    const heard: string[] = [];
    const stop = host.onParams((p) => heard.push(p.note));
    send({ type: 'params', params: { note: 'c' } });
    await tick();
    stop();
    send({ type: 'params', params: { note: 'd' } });
    await tick();
    expect(heard).toEqual(['b', 'c']);
    port1.close();
    port2.close();
  });

  it('is kept by a fixture, which shows nothing else', async () => {
    const h = fixtureHost();
    await h.call({ op: 'setParams', params: { note: 'n' } });
    expect(h.params()).toEqual({ note: 'n' });
    await expect(h.call({ op: 'openView', view: 'note-crud', params: { note: 'n' } })).resolves.toBe(false);
    expect(h.opened).toEqual([{ view: 'note-crud', params: { note: 'n' } }]);
    await h.call({ op: 'openView', view: 'source-manager', params: { source: 's' }, newTab: true });
    expect(h.opened.at(-1)).toEqual({ view: 'source-manager', params: { source: 's' }, newTab: true });
  });
});
