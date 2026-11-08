import { describe, expect, it } from 'vitest';
import { closeTab, moveBefore, openTab, parseTabs, serializeTabs, type Tab } from './tabs';

const tab = (id: string, view = 'note-crud'): Tab => ({ id, view, params: {} });
const ids = (tabs: Tab[]) => tabs.map((t) => t.id);

describe('stored tabs', () => {
  const defaults = ['note-crud', 'note-queue'];

  it('are the default panes when nothing usable is stored', () => {
    for (const raw of [null, 'not json', '{"v":2,"tabs":[]}', '{"v":1}', 'null']) {
      expect(parseTabs(raw, defaults).map((t) => t.view)).toEqual(defaults);
    }
  });

  it('stay empty once all are closed', () => {
    expect(parseTabs(serializeTabs([]), defaults)).toEqual([]);
  });

  it('round-trip, dropping malformed and duplicate entries', () => {
    const raw = JSON.stringify({ v: 1, tabs: [
      { id: 'a', view: 'note-queue', title: 'Mine', params: { deck: 'x', n: 3 } }, { id: 'b' }, 'c', { id: 'a', view: 'other' },
    ] });
    expect(parseTabs(raw, defaults)).toEqual([{ id: 'a', view: 'note-queue', title: 'Mine', params: { deck: 'x' } }]);
  });
});

describe('tab actions', () => {
  it('open a fresh instance each time, even of the same pane', () => {
    const one = openTab([], 'note-queue', { deck: 'x' });
    const two = openTab(one.tabs, 'note-queue');
    expect(two.tabs.map((t) => t.view)).toEqual(['note-queue', 'note-queue']);
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
