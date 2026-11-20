import type { DeckSource } from '@gestalts/client';

/** What a view's frame may be allowed beyond the strict sandbox; only the distribution grants it (`grants`). */
export type Permission = 'same-origin' | 'microphone';

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
  /** what its frame asks to be allowed; only the distribution grants it (`grants` in `distribution.yml`) */
  permissions?: Permission[];
  /** hosts it may reach through the node, exactly */
  network?: string[];
  /** asks for completions from the user's LLM providers */
  llm?: boolean;
};

/** One of a plugin's decks, as the build serves it: `source` is `<plugin>/<deck>`, `path` relative to the app. */
export type DeckEntry = { id: string; title: string; source: string; path: string };

/** A plugin the app is built with. */
export type PluginEntry = {
  manifest: PluginManifest;
  decks: DeckEntry[];
  /** its view, compiled */
  js: string;
  /** npm packages its view imports */
  npm: string[];
  /** can't be uninstalled here */
  core: boolean;
  /** what the distribution granted of what it asked for */
  granted: Permission[];
  /** it has a `backend.py`: required when the manifest says `requires: [backend]`, else optional */
  backend: boolean;
};

/** `id`: whose tabs and data are whose, for good. */
export type Distribution = { id: string; default_views: string[]; install_ui: boolean };

/** What every view's frame loads: React, the kit and the rest, as one script, and their styles. */
/** What every frame loads. `version` names it: a hash of `js`, so a lesson or draft can say what it was made against. */
export type FrameRuntime = { js: string; css: string; version: string };

/** `gestalts`: the definitions of the distribution's model packages, as YAML (the core's are compiled in). */
export type Registry = { distribution: Distribution; plugins: PluginEntry[]; gestalts: string[]; runtime: FrameRuntime };

export const findPlugin = (registry: Registry, id: string) => registry.plugins.find((p) => p.manifest.id === id);

export function deckSources(decks: DeckEntry[]): DeckSource[] {
  return decks.map((d) => ({ source: d.source, url: new URL(d.path, document.baseURI).href }));
}
