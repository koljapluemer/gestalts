import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { DeckSource } from '@gestalts/client';
import type { PaneProps, SlotProps } from '@gestalts/sdk';

/** Which notes a plugin's UI may read or write (`access` in `plugin.yml`). */
export type Scope = 'all' | { gestalts?: string[]; tags_all?: string[] };

export type PluginManifest = {
  id: string;
  version: string;
  host_api: number;
  title?: string;
  description?: string;
  gestalts?: string[];
  uses?: string[];
  panes?: PaneManifest[];
  slots?: { slot: string; gestalt: string; entry: string }[];
  /** a `defineLens` export per gestalt */
  lenses?: { gestalt: string; entry: string }[];
  access?: { read?: Scope; write?: Scope };
  worker?: unknown;
};

/** A pane in `plugin.yml`; `requires.services` are the node services it needs (see `paneSupport`). */
export type PaneManifest = { id: string; title: string; entry: string; requires?: { services?: string[] } };

/** A bundled plugin, as the app's build (`virtual:gestalts-plugins`) hands it to the host. */
export type PluginEntry = {
  manifest: PluginManifest;
  /** the definitions of the gestalts it owns, as YAML */
  gestalts: string[];
  /** its decks: `source` is `<plugin>/<deck>`, `path` relative to the app (`decks/<plugin>/<deck>`) */
  decks: DeckEntry[];
  /** its UI modules by path */
  modules: Record<string, () => Promise<Record<string, unknown>>>;
};

/** One of a plugin's decks, as the build serves it. */
export type DeckEntry = { id: string; title: string; source: string; path: string };

/** `id`: whose pane notes are whose; `plugins`: the ids of the plugins the app is built with */
export type Distribution = { id: string; plugins: string[]; default_panes: string[]; install_ui: boolean };

export type Registry = { distribution: Distribution; plugins: PluginEntry[] };

/** `<plugin>/<pane>` */
export const paneRef = (plugin: string, pane: string) => `${plugin}/${pane}`;

export function findPane(registry: Registry, ref: string): { plugin: PluginEntry; pane: PaneManifest } | undefined {
  const [id, paneId] = ref.split('/');
  const plugin = registry.plugins.find((p) => p.manifest.id === id);
  const pane = plugin?.manifest.panes?.find((p) => p.id === paneId);
  return plugin && pane ? { plugin, pane } : undefined;
}

export function deckSources(decks: DeckEntry[]): DeckSource[] {
  return decks.map((d) => ({ source: d.source, url: new URL(d.path, document.baseURI).href }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a plugin's export, typed by the caller
type AnyComponent = ComponentType<any>;

const loaded = new Map<string, LazyExoticComponent<AnyComponent>>();

/** What a plugin exports at `entry` (`<module>#<export>`), loaded. */
export async function entryExport<T>(plugin: PluginEntry, entry: string): Promise<T> {
  const [module, name] = entry.split('#');
  const load = plugin.modules[module];
  if (!load) throw new Error(`${plugin.manifest.id}: no module ${module}`);
  const exported = (await load())[name];
  if (exported === undefined) throw new Error(`${plugin.manifest.id}: ${module} exports no ${name}`);
  return exported as T;
}

/** The component a plugin exports at `entry` (`<module>#<export>`), loaded when first rendered. */
export function entryComponent<P>(plugin: PluginEntry, entry: string): LazyExoticComponent<ComponentType<P>> {
  const id = `${plugin.manifest.id}:${entry}`;
  let c = loaded.get(id);
  if (!c) {
    const [module, name] = entry.split('#');
    const load = plugin.modules[module];
    c = lazy(async () => {
      if (!load) throw new Error(`${plugin.manifest.id}: no module ${module}`);
      const m = await load();
      const exported = m[name];
      if (typeof exported !== 'function' && typeof exported !== 'object') throw new Error(`${plugin.manifest.id}: ${module} exports no ${name}`);
      return { default: exported as AnyComponent };
    });
    loaded.set(id, c);
  }
  return c as LazyExoticComponent<ComponentType<P>>;
}

export type PaneComponent = LazyExoticComponent<ComponentType<PaneProps>>;
export type SlotComponent = LazyExoticComponent<ComponentType<SlotProps>>;
