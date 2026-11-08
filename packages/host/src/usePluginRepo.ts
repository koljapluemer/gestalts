import { useEffect, useMemo, useState } from 'react';
import { useOpenRepo, type Repo, type YmlsIn } from '@gestalts/client';
import { deckSources, type PluginEntry, type Registry } from './registry';
import { installedPlugins, seedInstalls, wantedDecks } from './installs';

const MOUNTED = (dir: string) => `gestalts-mounted-decks:${dir}`;

/** The deck sources (`<plugin>/<deck>`) mounted last time in this browser; every deck at first. */
function mountedDecks(dir: string, registry: Registry): string[] {
  try {
    const saved = localStorage.getItem(MOUNTED(dir));
    if (saved) return JSON.parse(saved) as string[];
  } catch { /* no storage: mount every deck */ }
  return registry.plugins.flatMap((p) => p.decks.map((d) => d.source));
}

/**
 * The app's repo: ymls in OPFS under `dir` or in the folder of the node at `node` (`where`), with the gestalts of every
 * bundled plugin and the decks of the installed ones. Installs the distribution's plugins in a new folder. Which decks
 * to mount is only known once the folder is open, so it's remembered per browser; if the installs changed since, the
 * repo opens once more with the right decks.
 */
export function usePluginRepo(where: YmlsIn, registry: Registry): { repo?: Repo; installed: PluginEntry[]; decks: string[]; error?: string } {
  const dir = where.dir ?? (where.node !== undefined ? `node:${where.node}` : `native:${where.native}`);
  const [mounted, setMounted] = useState(() => mountedDecks(dir, registry));
  const whereKey = JSON.stringify(where);
  const source = useMemo(() => ({
    ...(JSON.parse(whereKey) as YmlsIn),
    decks: deckSources(registry.plugins.flatMap((p) => p.decks).filter((d) => mounted.includes(d.source))),
    gestalts: registry.plugins.flatMap((p) => p.gestalts),
  }), [whereKey, registry, mounted]);
  const { repo, error } = useOpenRepo(source);
  const [seeded, setSeeded] = useState<Repo | null>(null);
  useEffect(() => {
    if (!repo) return;
    let live = true;
    void repo.firstSync.then(() => seedInstalls(repo, registry)).then(() => {
      if (!live) return;
      const want = wantedDecks(repo, registry).map((d) => d.source);
      try { localStorage.setItem(MOUNTED(dir), JSON.stringify(want)); } catch { /* not remembered */ }
      if (want.join() !== mounted.join()) {
        repo.close(); // the repo with the right decks takes over, and its sync
        setMounted(want);
      } else setSeeded(repo);
    });
    return () => { live = false; };
  }, [repo, registry, dir, mounted]);
  const ready = seeded === repo ? repo : undefined;
  return { repo: ready, installed: ready ? installedPlugins(ready, registry) : [], decks: ready ? mounted : [], error };
}
