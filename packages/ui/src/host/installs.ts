import { useMemo } from 'react';
import { asMap, stableId, useQuery, useRepo, type IndexedNote, type Json, type Repo } from '@gestalts/sdk';
import type { DeckEntry, PluginEntry, Registry } from './registry';

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

/** Whether a deck of an installed plugin is mounted: all are, unless its install note says `decks: {<id>: false}`. */
export function deckEnabled(repo: Pick<Repo, 'get'>, p: PluginEntry, deck: string): boolean {
  return asMap(asMap(repo.get(installKey(p.manifest.id))?.value)?.decks ?? null)?.[deck] !== false;
}

/** The decks to mount: those of the installed plugins that aren't switched off. */
export function wantedDecks(repo: Pick<Repo, 'get' | 'isDeleted'>, registry: Registry): DeckEntry[] {
  return installedPlugins(repo, registry).flatMap((p) => p.decks.filter((d) => deckEnabled(repo, p, d.id)));
}

export async function setDeckEnabled(repo: Repo, p: PluginEntry, deck: string, enabled: boolean): Promise<void> {
  const key = installKey(p.manifest.id);
  const current = asMap(repo.get(key)?.value) ?? (installNote(p, true) as Record<string, Json>);
  const decks = { ...asMap(current.decks ?? null) };
  if (enabled) delete decks[deck];
  else decks[deck] = false;
  await repo.putValue(key, { ...current, decks });
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
 * Uninstalls a plugin: its decks are unmounted (after a reload), and its panes and views go. The user's copies of its
 * deck notes stay, since user space is closed under references, unless `removeData` asks to delete them too (only
 * copies that came from its decks alone: a note another plugin's deck holds as well stays).
 */
export async function uninstall(repo: Repo & { copiesOf(sources: string[]): Promise<string[]> }, p: PluginEntry, removeData: boolean): Promise<void> {
  if (removeData && p.decks.length) {
    for (const key of await repo.copiesOf(p.decks.map((d) => d.source))) await repo.delete(key);
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
