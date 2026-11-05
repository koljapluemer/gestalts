import { describe, expect, it } from 'vitest';
import { closeTab, moveBefore, openTab, parseTabs, serializeTabs, type Tab } from './tabs';

const tab = (id: string, pane = 'explorer/explorer'): Tab => ({ id, pane, params: {} });
const ids = (tabs: Tab[]) => tabs.map((t) => t.id);

describe('stored tabs', () => {
  const defaults = ['explorer/explorer', 'learn/learn'];

  it('are the default panes when nothing usable is stored', () => {
    for (const raw of [null, 'not json', '{"v":2,"tabs":[]}', '{"v":1}', 'null']) {
      expect(parseTabs(raw, defaults).map((t) => t.pane)).toEqual(defaults);
    }
  });

  it('stay empty once all are closed', () => {
    expect(parseTabs(serializeTabs([]), defaults)).toEqual([]);
  });

  it('round-trip, dropping malformed and duplicate entries', () => {
    const raw = JSON.stringify({ v: 1, tabs: [
      { id: 'a', pane: 'learn/learn', title: 'Mine', params: { deck: 'x', n: 3 } }, { id: 'b' }, 'c', { id: 'a', pane: 'quotes/quotes' },
    ] });
    expect(parseTabs(raw, defaults)).toEqual([{ id: 'a', pane: 'learn/learn', title: 'Mine', params: { deck: 'x' } }]);
  });
});

describe('tab actions', () => {
  it('open a fresh instance each time, even of the same pane', () => {
    const one = openTab([], 'learn/learn', { deck: 'x' });
    const two = openTab(one.tabs, 'learn/learn');
    expect(two.tabs.map((t) => t.pane)).toEqual(['learn/learn', 'learn/learn']);
    expect(one.id).not.toEqual(two.id);
    expect(two.tabs[0].params).toEqual({ deck: 'x' });
  });

  it('close, selecting the right neighbour, else the left one', () => {
    const tabs = [tab('a'), tab('b'), tab('c')];
    expect(closeTab(tabs, 'b')).toEqual({ tabs: [tab('a'), tab('c')], next: 'c' });
    expect(closeTab(tabs, 'c').next).toBe('b');
    expect(closeTab([tab('a')], 'a')).toEqual({ tabs: [], next: undefined });
    expect(closeTab(tabs, 'z').tabs).toBe(tabs);
  });

  it('move before another tab, or to the end', () => {
    const tabs = [tab('a'), tab('b'), tab('c')];
    expect(ids(moveBefore(tabs, 'c', 'a'))).toEqual(['c', 'a', 'b']);
    expect(ids(moveBefore(tabs, 'a', null))).toEqual(['b', 'c', 'a']);
    expect(ids(moveBefore(tabs, 'a', 'c'))).toEqual(['b', 'a', 'c']);
    expect(moveBefore(tabs, 'a', 'a')).toBe(tabs);
  });
});
