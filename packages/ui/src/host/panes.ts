import type { PaneManifest } from './registry';

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
