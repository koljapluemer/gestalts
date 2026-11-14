import { stableId, useHostQuery, type Repo } from '@gestalts/client';
import type { Item, JsonMap } from '@gestalts/view';
import { useMemo } from 'react';
import type { DeckEntry, PluginEntry, Registry } from './registry';

/** Whether each plugin is on, is a `plugin-install@1` yml per plugin, so the choice syncs. */
const INSTALL = 'plugin-install@1';

export const installId = (plugin: string) => stableId('plugin', plugin);

export type InstallState = 'installed' | 'disabled' | 'uninstalled';

/** The install ymls, by id, as last answered: what the host decides synchronously from (what to show). */
export type Installs = { get(id: string): Item | undefined };

/** The query the host follows the installs with; one, so everything showing them shares its answer. */
export const INSTALLS_QUERY = { gestalt: INSTALL, limit: 500 };

export function installsOf(items: Item[]): Installs {
  const byId = new Map(items.map((i) => [i.id, i]));
  return { get: (id) => byId.get(id) };
}

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

/** The plugin's install as it is now, as `Installs` for it alone. */
async function current(repo: Repo, p: PluginEntry): Promise<{ installs: Installs; value: JsonMap | undefined }> {
  const value = (await repo.get(installId(p.manifest.id)))?.value;
  const item = value && ({ id: installId(p.manifest.id), gestalt: INSTALL, value } as Item);
  return { installs: installsOf(item ? [item] : []), value };
}

export async function setDeckEnabled(repo: Repo, p: PluginEntry, deck: string, enabled: boolean): Promise<void> {
  const now = await current(repo, p);
  const decks = { ...decksOff(now.installs, p) };
  if (enabled) delete decks[deck];
  else decks[deck] = false;
  await repo.put({ ...installValue(p, true), ...now.value, decks });
}

/**
 * Installs the distribution's plugins in a folder that has never seen them: one yml each, under a stable id, so two
 * devices doing it at once write the same ymls. One uninstalled here before stays uninstalled.
 */
export async function seedInstalls(repo: Repo, registry: Registry): Promise<void> {
  for (const p of registry.plugins) {
    const id = installId(p.manifest.id);
    if (!(await repo.get(id)) && !(await repo.isDeleted(id))) await repo.put(installValue(p, true));
  }
}

export async function setEnabled(repo: Repo, p: PluginEntry, enabled: boolean): Promise<void> {
  await repo.put({ ...installValue(p, enabled), ...(await current(repo, p)).value, enabled, version: p.manifest.version });
}

export const install = (repo: Repo, p: PluginEntry) => repo.put(installValue(p, true));

/** Its view and decks go. What the user wrote while using it (their reviews, say) stays. */
export const uninstall = (repo: Repo, p: PluginEntry) => repo.delete(installId(p.manifest.id));

/** The installed plugins, kept current. */
export function useInstalled(registry: Registry): PluginEntry[] {
  const installs = useHostQuery(INSTALLS_QUERY);
  return useMemo(() => installedPlugins(installsOf(installs), registry), [registry, installs]);
}
