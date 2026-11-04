import { useMemo } from 'react';
import { asMap, stableId, useQuery, useRepo, type IndexedNote, type Json, type Repo } from '@gestalts/sdk';
import type { PluginEntry, Registry } from './registry';

/** The key of a plugin's `plugin-install@1` note. */
export const installKey = (id: string) => stableId('plugin', id);

export type InstallState = 'installed' | 'disabled' | 'uninstalled';

export function installState(repo: Pick<Repo, 'get' | 'isDeleted'>, id: string): InstallState {
  const n = repo.get(installKey(id));
  if (!n) return 'uninstalled';
  return asMap(n.value)?.enabled === false ? 'disabled' : 'installed';
}

/** The bundled plugins that are installed and enabled in this folder. */
export function installedPlugins(repo: Pick<Repo, 'get' | 'isDeleted'>, registry: Registry): PluginEntry[] {
  return registry.plugins.filter((p) => installState(repo, p.manifest.id) === 'installed');
}

function installNote(p: PluginEntry, enabled: boolean): Json {
  return { id: installKey(p.manifest.id), tags: ['plugin-install'], plugin: p.manifest.id, source: 'built-in', version: p.manifest.version, enabled };
}

/**
 * Installs the distribution's plugins in a folder that has never seen them: one note each, under a stable key, so
 * two devices doing it at once write the same notes. One uninstalled here before (a tombstone) stays uninstalled.
 */
export async function seedInstalls(repo: Repo, registry: Registry): Promise<void> {
  for (const p of registry.plugins) {
    const key = installKey(p.manifest.id);
    if (!repo.get(key) && !repo.isDeleted(key)) await repo.putValue(key, installNote(p, true));
  }
}

export async function setEnabled(repo: Repo, p: PluginEntry, enabled: boolean): Promise<void> {
  const key = installKey(p.manifest.id);
  const current = asMap(repo.get(key)?.value) ?? {};
  await repo.putValue(key, { ...(installNote(p, enabled) as Record<string, Json>), ...current, enabled, version: p.manifest.version });
}

/** Installs again after an uninstall. */
export async function install(repo: Repo, p: PluginEntry): Promise<void> {
  await repo.putValue(installKey(p.manifest.id), installNote(p, true));
}

/**
 * Uninstalls a plugin: its deck is unmounted (after a reload), and its panes and views go. The user's copies of its
 * deck notes stay, since user space is closed under references, unless `removeData` asks to delete them too.
 */
export async function uninstall(repo: Repo & { copiesOf(source: string, aliases: string[]): Promise<string[]> }, p: PluginEntry, removeData: boolean): Promise<void> {
  if (removeData && p.deck) {
    for (const key of await repo.copiesOf(p.deck.source, p.deck.aliases)) await repo.delete(key);
  }
  await repo.delete(installKey(p.manifest.id));
}

export const isInstallNote = (n: IndexedNote) => n.gestalts.includes('plugin-install@1');

/** The installed plugins, kept current. */
export function useInstalled(registry: Registry): PluginEntry[] {
  const repo = useRepo();
  const installs = useQuery({ gestalt: 'plugin-install@1' });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `installs` stands for the install notes
  return useMemo(() => installedPlugins(repo, registry), [repo, registry, installs]);
}
