import { asMap, field, stableId, str, type IndexedNote, type Json } from '@gestalts/sdk';
import type { PaneManifest } from './registry';

/** A `pane@1` note: one tab. `distribution` is the app it's a tab of; older notes have none until a host adopts them. */
export type PaneNote = { key: string; ref: string; distribution?: string; title?: string; params: Record<string, string>; order: number };

export function paneNote(n: IndexedNote): PaneNote | null {
  const ref = str(n, 'pane');
  if (!ref) return null;
  const order = asMap(field(n, 'position') ?? null)?.order;
  const params = Object.fromEntries(Object.entries(asMap(field(n, 'params') ?? null) ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'));
  return { key: n.key, ref, distribution: str(n, 'distribution'), title: str(n, 'title'), params, order: typeof order === 'number' ? order : 0 };
}

export const paneValue = (key: string, distribution: string, ref: string, order: number, at: string, extra: Record<string, Json> = {}): Json =>
  ({ id: key, tags: ['pane'], pane: ref, distribution, ...extra, position: { order, at } });

/** This distribution's panes, in tab order. */
export function ownPanes(notes: IndexedNote[], distribution: string): PaneNote[] {
  return notes.flatMap((n) => paneNote(n) ?? [])
    .filter((p) => p.distribution === distribution)
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

/** Pane notes from before distributions, which the first tab host to see them adopts. */
export const unclaimedPanes = (notes: IndexedNote[]): IndexedNote[] => notes.filter((n) => { const p = paneNote(n); return p && !p.distribution; });

/** The key a distribution seeds a default pane under, the same on each of its devices. */
export const defaultPaneKey = (distribution: string, ref: string) => stableId('pane', `${distribution}/${ref}`);

/**
 * Whether this host can run a pane: `missing` if it requires a service the node doesn't offer (or there's no node),
 * `unavailable` if the node offers it but it isn't running. `ok` while the services aren't known yet.
 */
export type PaneSupport = { state: 'ok' } | { state: 'missing' | 'unavailable'; services: string[] };

export function paneSupport(pane: Pick<PaneManifest, 'requires'>, services: Map<string, boolean> | undefined): PaneSupport {
  const required = pane.requires?.services ?? [];
  if (!services) return { state: 'ok' };
  const missing = required.filter((s) => !services.has(s));
  if (missing.length) return { state: 'missing', services: missing };
  const down = required.filter((s) => !services.get(s));
  return down.length ? { state: 'unavailable', services: down } : { state: 'ok' };
}

export function supportText(s: PaneSupport): string | undefined {
  if (s.state === 'ok') return undefined;
  const names = s.services.join(', ');
  return s.state === 'missing'
    ? `Needs ${names}, which this device doesn't offer: parts of this pane won't work.`
    : `Needs ${names}, which isn't running yet (see the desktop app).`;
}
