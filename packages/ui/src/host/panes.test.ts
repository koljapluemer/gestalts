import { describe, expect, it } from 'vitest';
import type { IndexedNote, Json } from '@gestalts/sdk';
import { ownPanes, paneSupport, unclaimedPanes } from './panes';

const note = (key: string, value: Json): IndexedNote => ({ key, id: key, raw: '', value, parse_error: null, gestalts: ['pane@1'], lints: [] });
const pane = (key: string, ref: string, order: number, distribution?: string) =>
  note(key, { tags: ['pane'], pane: ref, ...(distribution ? { distribution } : {}), position: { order, at: '1970-01-01T00:00:00.000Z' } });

describe('pane notes per distribution', () => {
  const notes = [pane('b', 'learn/learn', 2, 'desktop'), pane('a', 'explorer/explorer', 1, 'desktop'), pane('c', 'learn/learn', 0, 'android'), pane('d', 'quotes/quotes', 3)];

  it('shows a distribution only its own, in order', () => {
    expect(ownPanes(notes, 'desktop').map((p) => p.key)).toEqual(['a', 'b']);
    expect(ownPanes(notes, 'android').map((p) => p.key)).toEqual(['c']);
  });

  it('finds the notes from before distributions', () => {
    expect(unclaimedPanes(notes).map((n) => n.key)).toEqual(['d']);
  });
});

describe('pane support', () => {
  const requires = { requires: { services: ['typst@1'] } };

  it('needs nothing without requirements', () => {
    expect(paneSupport({}, new Map())).toEqual({ state: 'ok' });
  });

  it('assumes support while the services are unknown', () => {
    expect(paneSupport(requires, undefined)).toEqual({ state: 'ok' });
  });

  it('tells a missing service from one that is not running', () => {
    expect(paneSupport(requires, new Map())).toEqual({ state: 'missing', services: ['typst@1'] });
    expect(paneSupport(requires, new Map([['typst@1', false]]))).toEqual({ state: 'unavailable', services: ['typst@1'] });
    expect(paneSupport(requires, new Map([['typst@1', true]]))).toEqual({ state: 'ok' });
  });
});
