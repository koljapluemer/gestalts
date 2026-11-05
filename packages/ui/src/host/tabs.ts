import { useCallback, useSyncExternalStore } from 'react';

/**
 * One open tab: an instance of the pane `pane` (`<plugin>/<pane>`) with settings of its own (`params`). Its `id` is
 * the instance's, not the pane's, so the same pane can be open more than once.
 */
export type Tab = { id: string; pane: string; title?: string; params: Record<string, string> };

/** Where a distribution's tabs live in this browser: `{v: 1, tabs}`, in tab order. */
export const tabsKey = (distribution: string) => `gestalts-tabs:${distribution}`;

/** A tab id: only this browser's tabs need to tell it apart (`getRandomValues` works outside secure contexts too). */
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

const defaultTabs = (panes: string[]): Tab[] => panes.map((pane) => ({ id: newId(), pane, params: {} }));

function asTab(t: unknown): Tab | null {
  if (!t || typeof t !== 'object') return null;
  const { id, pane, title, params } = t as Record<string, unknown>;
  if (typeof id !== 'string' || !id || typeof pane !== 'string' || !pane) return null;
  const p = params && typeof params === 'object' && !Array.isArray(params)
    ? Object.fromEntries(Object.entries(params).filter((e): e is [string, string] => typeof e[1] === 'string'))
    : {};
  return { id, pane, ...(typeof title === 'string' ? { title } : {}), params: p };
}

/** The stored tabs; the default panes when nothing (usable) is stored. An empty list stays empty: all closed. */
export function parseTabs(raw: string | null, defaults: string[]): Tab[] {
  if (raw === null) return defaultTabs(defaults);
  try {
    const v = JSON.parse(raw) as { v?: unknown; tabs?: unknown };
    if (v?.v !== 1 || !Array.isArray(v.tabs)) return defaultTabs(defaults);
    const seen = new Set<string>();
    return v.tabs.flatMap((t) => { const tab = asTab(t); if (!tab || seen.has(tab.id)) return []; seen.add(tab.id); return [tab]; });
  } catch {
    return defaultTabs(defaults);
  }
}

export const serializeTabs = (tabs: Tab[]) => JSON.stringify({ v: 1, tabs });

/** A new instance of `pane`, at the end. */
export function openTab(tabs: Tab[], pane: string, params: Record<string, string> = {}): { tabs: Tab[]; id: string } {
  const id = newId();
  return { tabs: [...tabs, { id, pane, params }], id };
}

/** Without tab `id`; `next` is the tab to select instead (its right neighbour, else its left one). */
export function closeTab(tabs: Tab[], id: string): { tabs: Tab[]; next?: string } {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return { tabs };
  return { tabs: tabs.filter((t) => t.id !== id), next: (tabs[i + 1] ?? tabs[i - 1])?.id };
}

/** Tab `id` moved in front of tab `before`, or to the end. */
export function moveBefore(tabs: Tab[], id: string, before: string | null): Tab[] {
  const moved = tabs.find((t) => t.id === id);
  if (!moved || id === before) return tabs;
  const rest = tabs.filter((t) => t.id !== id);
  const i = before === null ? rest.length : rest.findIndex((t) => t.id === before);
  if (i < 0) return tabs;
  return [...rest.slice(0, i), moved, ...rest.slice(i)];
}

/** Per key: the tabs as last read or written, so every hook on it (and a render) sees the same array. */
const cache = new Map<string, { raw: string | null; tabs: Tab[] }>();
const listeners = new Set<() => void>();

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return cache.get(key)?.raw ?? null; }
}

function current(key: string, defaults: string[]): Tab[] {
  const raw = read(key);
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.tabs;
  const tabs = parseTabs(raw, defaults);
  // seeded defaults are written right away, so their ids hold across reloads and windows
  const stored = raw ?? serializeTabs(tabs);
  if (raw === null) { try { localStorage.setItem(key, stored); } catch { /* kept for this session only */ } }
  cache.set(key, { raw: stored, tabs });
  return tabs;
}

function write(key: string, tabs: Tab[]) {
  const raw = serializeTabs(tabs);
  cache.set(key, { raw, tabs });
  try { localStorage.setItem(key, raw); } catch { /* kept for this session only */ }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  // another window of the app changed them
  const onStorage = () => l();
  addEventListener('storage', onStorage);
  return () => { listeners.delete(l); removeEventListener('storage', onStorage); };
}

/** The distribution's tabs in this browser, and a setter that stores them. */
export function useTabs(distribution: string, defaults: string[]): [Tab[], (tabs: Tab[]) => void] {
  const key = tabsKey(distribution);
  const tabs = useSyncExternalStore(subscribe, () => current(key, defaults));
  const set = useCallback((next: Tab[]) => write(key, next), [key]);
  return [tabs, set];
}
