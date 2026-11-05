import { useMemo, useSyncExternalStore } from 'react';
import { asMap, type NoteSeed } from '@gestalts/sdk';
import { setUrlParams, subscribeUrl as subscribe } from '@gestalts/kit';

/** What a pane shows over itself: at most one thing. Opening another replaces it. */
export type Overlay =
  | { kind: 'note'; key: string }
  | { kind: 'new'; seed: NoteSeed };

const PARAM = 'overlay';
/** a new note's seed, as JSON */
const SEED = 'seed';
/** history state of an entry made by `open`, so closing it can go back instead */
const PUSHED = 'gestalts-overlay';

/** The overlay's query params; `null` removes one. */
export function encodeOverlay(o: Overlay | null): Record<string, string | null> {
  const none = { [PARAM]: null, [SEED]: null };
  if (!o) return none;
  if (o.kind === 'note') return { ...none, [PARAM]: `note:${o.key}` };
  return { ...none, [PARAM]: 'new', [SEED]: Object.keys(o.seed).length ? JSON.stringify(o.seed) : null };
}

export function decodeOverlay(params: URLSearchParams): Overlay | null {
  const v = params.get(PARAM);
  if (v === 'new') return { kind: 'new', seed: parseSeed(params.get(SEED)) };
  if (v?.startsWith('note:') && v.length > 5) return { kind: 'note', key: v.slice(5) };
  return null;
}

/** A seed from the URL; what isn't one (edited by hand, an old link) is dropped. */
function parseSeed(text: string | null): NoteSeed {
  if (!text) return {};
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return {}; }
  const m = asMap(raw as never);
  if (!m) return {};
  const seed: NoteSeed = {};
  const value = asMap(m.value);
  if (value) seed.value = value;
  if (typeof m.gestalt === 'string') seed.gestalt = m.gestalt;
  const relate = asMap(m.relate);
  if (relate && typeof relate.from === 'string') seed.relate = { from: relate.from, ...(typeof relate.label === 'string' ? { label: relate.label } : {}) };
  if (m.preset === 'capture' || m.preset === 'gestalt' || m.preset === 'full') seed.preset = m.preset;
  return seed;
}

export type OverlayControl = {
  /** a new history entry, so Back closes it */
  open: (o: Overlay) => void;
  /** in place, e.g. a created note replacing its form; `null` clears it without going back */
  replace: (o: Overlay | null) => void;
  close: () => void;
};

/** The pane's overlay, kept in the URL; every caller sees the same one. */
export function useOverlay(): [Overlay | null, OverlayControl] {
  const search = useSyncExternalStore(subscribe, () => location.search);
  const overlay = useMemo(() => decodeOverlay(new URLSearchParams(search)), [search]);
  const control = useMemo<OverlayControl>(() => ({
    open: (o) => {
      const open = decodeOverlay(new URLSearchParams(location.search));
      // already showing one: navigate within it rather than stacking history entries
      if (open) setUrlParams(encodeOverlay(o));
      else setUrlParams(encodeOverlay(o), { state: PUSHED });
    },
    replace: (o) => setUrlParams(encodeOverlay(o)),
    close: () => {
      if (history.state === PUSHED) history.back();
      else setUrlParams(encodeOverlay(null));
    },
  }), []);
  return [overlay, control];
}
