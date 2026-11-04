import { useMemo, useSyncExternalStore } from 'react';
import { setUrlParams, subscribeUrl as subscribe } from '@gestalts/kit';

/** What a pane shows over itself: at most one thing. Opening another replaces it. */
export type Overlay =
  | { kind: 'note'; key: string }
  | { kind: 'new'; title?: string; tags?: string[] };

const PARAM = 'overlay';
const TITLE = 'new-title';
const TAGS = 'new-tags';
/** history state of an entry made by `open`, so closing it can go back instead */
const PUSHED = 'gestalts-overlay';

/** The overlay's query params; `null` removes one. */
export function encodeOverlay(o: Overlay | null): Record<string, string | null> {
  const none = { [PARAM]: null, [TITLE]: null, [TAGS]: null };
  if (!o) return none;
  if (o.kind === 'note') return { ...none, [PARAM]: `note:${o.key}` };
  return { ...none, [PARAM]: 'new', [TITLE]: o.title || null, [TAGS]: o.tags?.length ? o.tags.join(',') : null };
}

export function decodeOverlay(params: URLSearchParams): Overlay | null {
  const v = params.get(PARAM);
  if (v === 'new') {
    const title = params.get(TITLE) ?? undefined;
    const tags = params.get(TAGS)?.split(',').filter(Boolean);
    return { kind: 'new', ...(title ? { title } : {}), ...(tags?.length ? { tags } : {}) };
  }
  if (v?.startsWith('note:') && v.length > 5) return { kind: 'note', key: v.slice(5) };
  return null;
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
