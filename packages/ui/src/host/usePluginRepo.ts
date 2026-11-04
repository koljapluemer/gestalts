import { useEffect, useMemo, useState } from 'react';
import { useOpenRepo, type Repo } from '@gestalts/client';
import { deckSources, type PluginEntry, type Registry } from './registry';
import { installedPlugins, seedInstalls } from './installs';

const MOUNTED = (dir: string) => `gestalts-mounted-decks:${dir}`;

function mountedDecks(dir: string, registry: Registry): string[] {
  try {
    const saved = localStorage.getItem(MOUNTED(dir));
    if (saved) return JSON.parse(saved) as string[];
  } catch { /* no storage: mount every deck */ }
  return registry.plugins.filter((p) => p.deck).map((p) => p.manifest.id);
}

/**
 * The app's repo: notes in OPFS under `dir`, with the gestalts of every bundled plugin (so their merge rules apply
 * even to plugins uninstalled here) and the decks of the installed ones. Installs the distribution's plugins in a
 * new folder. Which decks to mount is only known once the folder is open, so it's remembered per browser; if the
 * installs changed since (on another device, say), the repo opens once more with the right decks.
 */
export function usePluginRepo(dir: string, registry: Registry): { repo?: Repo; installed: PluginEntry[]; error?: string } {
  const [mounted, setMounted] = useState(() => mountedDecks(dir, registry));
  const source = useMemo(() => ({
    dir,
    decks: deckSources(registry.plugins.filter((p) => mounted.includes(p.manifest.id))),
    gestalts: registry.plugins.flatMap((p) => p.gestalts),
  }), [dir, registry, mounted]);
  const { repo, error } = useOpenRepo(source);
  const [seeded, setSeeded] = useState<Repo | null>(null);
  useEffect(() => {
    if (!repo) return;
    let live = true;
    void repo.firstSync.then(() => seedInstalls(repo, registry)).then(() => {
      if (!live) return;
      const want = installedPlugins(repo, registry).filter((p) => p.deck).map((p) => p.manifest.id);
      try { localStorage.setItem(MOUNTED(dir), JSON.stringify(want)); } catch { /* not remembered */ }
      if (want.join() !== mounted.join()) {
        repo.close(); // the repo with the right decks takes over, and its sync
        setMounted(want);
      } else setSeeded(repo);
    });
    return () => { live = false; };
  }, [repo, registry, dir, mounted]);
  const ready = seeded === repo ? repo : undefined;
  return { repo: ready, installed: ready ? installedPlugins(ready, registry) : [], error };
}
