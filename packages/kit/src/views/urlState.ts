import { useCallback, useSyncExternalStore } from 'react';

/** A comma-separated list in the URL's query string, so a reload keeps it. */
export function useUrlList(name: string): [string[], (next: string[]) => void] {
  const raw = useSyncExternalStore(subscribe, () => new URLSearchParams(location.search).get(name) ?? '');
  const set = useCallback((next: string[]) => {
    setUrlParams({ [name]: next.length ? next.join(',') : null });
  }, [name]);
  return [raw ? raw.split(',') : [], set];
}

/**
 * Sets (or with `null` removes) query params and tells every URL hook. `push` makes a new history entry,
 * marked with `state`, so Back undoes it; otherwise the current entry is replaced and keeps its state.
 */
export function setUrlParams(patch: Record<string, string | null>, push?: { state: unknown }) {
  const params = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) params.delete(k);
    else params.set(k, v);
  }
  const qs = params.toString();
  const url = `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`;
  if (push) history.pushState(push.state, '', url);
  else history.replaceState(history.state, '', url);
  listeners.forEach((l) => l());
}

const listeners = new Set<() => void>();
export function subscribe(l: () => void) {
  listeners.add(l);
  window.addEventListener('popstate', l);
  return () => { listeners.delete(l); window.removeEventListener('popstate', l); };
}
