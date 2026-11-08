import type { DeckSource } from '@gestalts/client';

/** A plugin's `plugin.yml`. */
export type PluginManifest = {
  id: string;
  version: string;
  title: string;
  description?: string;
  reads?: string[];
  writes?: string[];
  tags?: string[];
  requires?: 'backend'[];
};

/** One of a plugin's decks, as the build serves it: `source` is `<plugin>/<deck>`, `path` relative to the app. */
export type DeckEntry = { id: string; title: string; source: string; path: string };

/** A plugin the app is built with. */
export type PluginEntry = {
  manifest: PluginManifest;
  /** the definitions of the gestalts it owns, as YAML */
  gestalts: string[];
  decks: DeckEntry[];
  /** its view, compiled */
  js: string;
  /** npm packages its view imports */
  npm: string[];
  /** can't be uninstalled here */
  core: boolean;
};

/** `id`: whose tabs and data are whose, for good. */
export type Distribution = { id: string; default_views: string[]; install_ui: boolean };

/** What every view's frame loads: React, the kit and the rest, as one script, and their styles. */
export type FrameRuntime = { js: string; css: string };

export type Registry = { distribution: Distribution; plugins: PluginEntry[]; runtime: FrameRuntime };

export const findPlugin = (registry: Registry, id: string) => registry.plugins.find((p) => p.manifest.id === id);

export function deckSources(decks: DeckEntry[]): DeckSource[] {
  return decks.map((d) => ({ source: d.source, url: new URL(d.path, document.baseURI).href }));
}
