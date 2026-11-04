import { describe, expect, it } from 'vitest';
import { acknowledge, adopt, attached, folded, foldWrites, readCanvas, readCards, readTemplate, staleFolds, unwritable, type Hashing } from './fold';
import type { IndexedNote, Json } from './types';

// stand-ins for the core's hashes (tested there): distinct texts give distinct values
const h: Hashing = { cardId: (front) => `card:${front.trim()}`, contentHash: (text) => `hash:${text}` };

function note(key: string, value: Json): IndexedNote {
  return { key, id: key, raw: JSON.stringify(value), value, parse_error: null, gestalts: [], lints: [] };
}
/** a note after writing `value` to it */
const after = (n: IndexedNote, value: Json) => note(n.key, value);

const host = note('h', { title: 'Host', main: 'text', relationships: [{ to: 'x', label: 'inline' }] });
const oldCanvas = note('c', {
  tags: ['canvas'], nodes: [{ id: 'a', x: 0, y: 0, note: 'n1' }, { id: 'b', x: 1, y: 1, text: 'hi' }],
  relationships: [{ to: 'h', label: 'canvas-of' }, { to: 'n1', label: 'on-canvas' }],
});

describe('fold', () => {
  it('reads the host first, else the attached note', () => {
    expect(readCanvas(host, []).from).toBe('none');
    expect(readCanvas(host, attached([oldCanvas], 'h', 'canvas'))).toEqual({ value: (oldCanvas.value as { nodes: Json }).nodes, from: 'attached' });
    const withKey = after(host, { ...(host.value as object), canvas: { nodes: [] } });
    expect(readCanvas(withKey, [oldCanvas])).toEqual({ value: [], from: 'host' });
  });

  it('folds a canvas into the host and retires the old note', () => {
    const nodes = [{ id: 'a', x: 5, y: 0, note: 'n2' }];
    const w = foldWrites(host, 'canvas', { nodes }, [oldCanvas], h);
    expect(w.host).toEqual({
      title: 'Host', main: 'text', canvas: { nodes },
      relationships: [{ to: 'x', label: 'inline' }, { to: 'n2', label: 'on-canvas' }],
    });
    expect(w.retire).toHaveLength(1);
    const retired = after(oldCanvas, w.retire[0].value);
    expect(retired.value).toMatchObject({ tags: ['canvas', 'retired'], folded: { into: 'h' } });
    // retired notes are no longer attached, but folded, and not stale
    expect(attached([retired], 'h', 'canvas')).toEqual([]);
    expect(folded([retired], 'h', 'canvas')).toEqual([retired]);
    expect(staleFolds([retired], 'canvas', h)).toEqual([]);
    // later saves have nothing to retire
    expect(foldWrites(after(host, w.host), 'canvas', { nodes: [] }, [], h).host.relationships).toEqual([{ to: 'x', label: 'inline' }]);
  });

  it('offers a folded note edited afterwards, both ways', () => {
    const w = foldWrites(host, 'canvas', { nodes: [] }, [oldCanvas], h);
    const hostNow = after(host, w.host);
    const retired = after(oldCanvas, w.retire[0].value);
    const edited = after(retired, { ...(retired.value as object), nodes: [{ id: 'z', x: 9, y: 9, text: 'from elsewhere' }] });
    expect(staleFolds([edited], 'canvas', h)).toEqual([edited]);
    expect(adopt(hostNow, edited, 'canvas', h)).toEqual({ nodes: [{ id: 'z', x: 9, y: 9, text: 'from elsewhere' }] });
    expect(staleFolds([after(edited, acknowledge(edited, 'canvas', h))], 'canvas', h)).toEqual([]);
  });

  it('folds cards with their relationships and blobs, ids from the front', () => {
    const card = (key: string, front: string, extra: object = {}) =>
      note(key, { tags: ['flashcard'], front, back: `${front}!`, relationships: [{ to: 'h', label: 'card-of' }], ...extra });
    const c1 = card('k1', 'Was ist das?', { relationships: [{ to: 'h', label: 'card-of' }, { to: 'y', label: 'inline' }, { to: 'x', label: 'inline' }], blobs: ['img.webp'] });
    const c2 = card('k2', 'zwei');
    const read = readCards(host, attached([c2, c1], 'h', 'cards'), h);
    expect(read.from).toBe('attached');
    expect(read.value).toEqual([{ id: h.cardId('Was ist das?'), front: 'Was ist das?', back: 'Was ist das?!' }, { id: h.cardId('zwei'), front: 'zwei', back: 'zwei!' }]);
    const w = foldWrites(host, 'cards', read.value!, [c1, c2], h);
    expect(w.host.relationships).toEqual([{ to: 'x', label: 'inline' }, { to: 'y', label: 'inline' }]);
    expect(w.host.blobs).toEqual(['img.webp']);
    expect(w.retire.map((r) => r.value.folded)).toMatchObject([{ into: 'h', card: h.cardId('Was ist das?') }, { into: 'h', card: h.cardId('zwei') }]);

    // an edited front keeps its id; the retired note edited elsewhere comes back as that card
    const hostNow = after(host, { ...w.host, cards: [{ id: h.cardId('Was ist das?'), front: 'Was ist denn das?', back: 'b' }, read.value![1]] });
    expect(readCards(hostNow, [], h).value![0].id).toBe(h.cardId('Was ist das?'));
    const retired1 = after(c1, w.retire[0].value);
    const edited = after(retired1, { ...(retired1.value as object), back: 'changed' });
    expect(adopt(hostNow, edited, 'cards', h)).toEqual([{ id: h.cardId('Was ist das?'), front: 'Was ist das?', back: 'changed' }, read.value![1]]);
  });

  it('folds a template, keeping its file name', () => {
    const t = note('t', { title: '_index.html.j2', tags: ['template'], format: 'jinja-html', source: '<h1/>', relationships: [{ to: 'h', label: 'template-of' }] });
    const read = readTemplate(host, attached([t], 'h', 'template'));
    expect(read).toEqual({ value: { format: 'jinja-html', source: '<h1/>', name: '_index.html.j2' }, from: 'attached' });
    expect(foldWrites(host, 'template', read.value!, [t], h).host.template).toEqual(read.value);
  });

  it("doesn't write over a note that doesn't parse", () => {
    const broken: IndexedNote = { ...note('b', null), raw: 'a: [', parse_error: { message: 'bad', line: 1, column: 4 } };
    expect(unwritable(broken)).toMatch(/doesn't parse/);
    expect(() => foldWrites(broken, 'canvas', { nodes: [] }, [], h)).toThrow();
    expect(unwritable(note('s', 'just a string'))).toMatch(/not a YAML map/);
    expect(unwritable(note('e', null))).toBeNull();
  });
});
