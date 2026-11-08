import { stableId, useHostQuery, useHostRepo, type Repo } from '@gestalts/client';
import type { JsonMap } from '@gestalts/view';
import { useMemo } from 'react';
import type { DeckEntry, PluginEntry, Registry } from './registry';

/** Whether each plugin is on, is a `plugin-install@1` yml per plugin, so the choice syncs. */
const INSTALL = 'plugin-install@1';

export const installId = (plugin: string) => stableId('plugin', plugin);

export type InstallState = 'installed' | 'disabled' | 'uninstalled';

type Installs = Pick<Repo, 'get'>;

export function installState(repo: Installs, plugin: string): InstallState {
  const n = repo.get(installId(plugin));
  if (!n) return 'uninstalled';
  return n.value.enabled === false ? 'disabled' : 'installed';
}

export function installedPlugins(repo: Installs, registry: Registry): PluginEntry[] {
  return registry.plugins.filter((p) => p.core || installState(repo, p.manifest.id) === 'installed');
}

function decksOff(repo: Installs, p: PluginEntry): JsonMap {
  const decks = repo.get(installId(p.manifest.id))?.value.decks;
  return decks && typeof decks === 'object' && !Array.isArray(decks) ? decks : {};
}

/** All decks of an installed plugin are mounted, unless its install says `decks: {<id>: false}`. */
export const deckEnabled = (repo: Installs, p: PluginEntry, deck: string) => decksOff(repo, p)[deck] !== false;

/** The decks to mount: those of the installed plugins that aren't switched off. */
export function wantedDecks(repo: Installs, registry: Registry): DeckEntry[] {
  return installedPlugins(repo, registry).flatMap((p) => p.decks.filter((d) => deckEnabled(repo, p, d.id)));
}

const installValue = (p: PluginEntry, enabled: boolean): JsonMap => ({
  id: installId(p.manifest.id), gestalt: INSTALL, plugin: p.manifest.id, source: 'built-in', version: p.manifest.version, enabled,
});

export async function setDeckEnabled(repo: Repo, p: PluginEntry, deck: string, enabled: boolean): Promise<void> {
  const decks = { ...decksOff(repo, p) };
  if (enabled) delete decks[deck];
  else decks[deck] = false;
  await repo.put({ ...installValue(p, true), ...repo.get(installId(p.manifest.id))?.value, decks });
}

/**
 * Installs the distribution's plugins in a folder that has never seen them: one yml each, under a stable id, so two
 * devices doing it at once write the same ymls. One uninstalled here before stays uninstalled.
 */
export async function seedInstalls(repo: Repo, registry: Registry): Promise<void> {
  for (const p of registry.plugins) {
    const id = installId(p.manifest.id);
    if (!repo.get(id) && !repo.isDeleted(id)) await repo.put(installValue(p, true));
  }
}

export async function setEnabled(repo: Repo, p: PluginEntry, enabled: boolean): Promise<void> {
  await repo.put({ ...installValue(p, enabled), ...repo.get(installId(p.manifest.id))?.value, enabled, version: p.manifest.version });
}

export const install = (repo: Repo, p: PluginEntry) => repo.put(installValue(p, true));

/** Its view and decks go. What the user wrote while using it (their reviews, say) stays. */
export const uninstall = (repo: Repo, p: PluginEntry) => repo.delete(installId(p.manifest.id));

/** The installed plugins, kept current. */
export function useInstalled(registry: Registry): PluginEntry[] {
  const repo = useHostRepo();
  const installs = useHostQuery({ gestalt: INSTALL, limit: 500 });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `installs` stands for the install ymls
  return useMemo(() => installedPlugins(repo, registry), [repo, registry, installs]);
}
