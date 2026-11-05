import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { refsOf } from '@gestalts/kit';
import { useSettings, type IndexedNote, type Json, type Repo } from '@gestalts/sdk';
import { GraphView, buildGraph, readPins, type NoteGraph, type Pin } from './graph';

/** What a note pinned from the search, the toolbar or a card shows around it. */
export const SEARCH_PIN_DEPTH = 2;
export const MANUAL_PIN_DEPTH = 1;
export const CREATED_PIN_DEPTH = 1;
/** "Pin all from search" pins the notes alone, so a broad query doesn't flood the graph with their neighbours. */
export const PIN_ALL_DEPTH = 0;
export const PIN_ALL_CAP = 100;

/** How long pin changes wait before they're written to the settings note, so stepping a depth writes once. */
const SAVE_DELAY_MS = 800;

export type Pins = ReadonlyMap<string, number>;

export type UseGraph = {
  view: GraphView;
  graph: NoteGraph;
  pins: Pins;
  pin: (key: string, depth: number) => void;
  pinAll: (keys: readonly string[], depth: number) => void;
  unpin: (key: string) => void;
  /** keeps only `key` pinned */
  unpinOthers: (key: string) => void;
  setDepth: (key: string, depth: number) => void;
  /** pins `key` at `depth` unless it's pinned at least that deep */
  pinAtLeast: (key: string, depth: number) => void;
  clear: () => void;
};

/**
 * The pins and the graph they show. The pins are kept in the graph's settings (`settings@1`, scope `graph`), so they
 * sync and the graph opens as it was left; while the pane is open its own state is the truth, written back shortly
 * after each change.
 */
export function useGraph(repo: Repo, scoped: IndexedNote[]): UseGraph {
  const [settings, saveSettings] = useSettings<{ pins: Json }>('graph', { pins: [] });
  const [pins, setPins] = useState<Map<string, number>>(() => new Map(readPins(settings.pins).map((p) => [p.key, p.depth])));

  const written = useRef(pins);
  const latest = useRef(pins);
  const save = useCallback((p: Map<string, number>) => {
    if (p === written.current) return;
    written.current = p;
    const list: Pin[] = [...p].map(([key, depth]) => ({ key, depth }));
    saveSettings({ pins: list }).catch((e: unknown) => console.error('graph: pins not saved', e));
  }, [saveSettings]);
  useEffect(() => {
    latest.current = pins;
    const timer = setTimeout(() => save(pins), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [pins, save]);
  // closing the pane writes what's still waiting
  useEffect(() => () => save(latest.current), [save]);

  const view = useMemo(() => new GraphView(scoped, (id) => repo.keyOf(id), refsOf), [repo, scoped]);
  const pinList = useMemo(() => [...pins].map(([key, depth]) => ({ key, depth })), [pins]);
  const graph = useMemo(() => buildGraph(view, pinList), [view, pinList]);

  const update = (change: (prev: Map<string, number>) => Map<string, number>) => setPins(change);
  const pin = useCallback((key: string, depth: number) => update((p) => (p.has(key) ? p : new Map(p).set(key, depth))), []);
  const pinAll = useCallback((keys: readonly string[], depth: number) => update((p) => {
    const missing = keys.filter((k) => !p.has(k));
    if (!missing.length) return p;
    const next = new Map(p);
    for (const k of missing) next.set(k, depth);
    return next;
  }), []);
  const unpin = useCallback((key: string) => update((p) => {
    if (!p.has(key)) return p;
    const next = new Map(p);
    next.delete(key);
    return next;
  }), []);
  const unpinOthers = useCallback((key: string) => update((p) => {
    const depth = p.get(key);
    return depth === undefined || p.size === 1 ? p : new Map([[key, depth]]);
  }), []);
  const setDepth = useCallback((key: string, depth: number) => update((p) => (p.has(key) ? new Map(p).set(key, Math.max(0, depth)) : p)), []);
  const pinAtLeast = useCallback((key: string, depth: number) => update((p) => {
    const current = p.get(key);
    return current !== undefined && current >= depth ? p : new Map(p).set(key, depth);
  }), []);
  const clear = useCallback(() => update(() => new Map()), []);

  return { view, graph, pins, pin, pinAll, unpin, unpinOthers, setDepth, pinAtLeast, clear };
}
