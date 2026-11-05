import type { ComponentType } from 'react';
import type { JsonMap } from './fields';
import type { Repo } from './port';
import type { FieldRule, Json } from './types';

/**
 * One field of a note, shown by the note component: rendered when there's no `onChange`, else edited. `undefined`
 * as a value is a field the note doesn't have (yet).
 */
export type FieldProps = {
  /** the top-level key */
  path: string;
  value: Json | undefined;
  /** what the gestalts claiming it ask of it; null for a field none claims */
  rule: FieldRule | null;
  /** given: editable; `undefined` takes the field off the note */
  onChange?: (value: Json | undefined) => void;
  /** the whole note, as drafted */
  note: JsonMap;
};

/** How a lens shows one of its gestalt's fields; anything left out is the note component's default. */
export type LensField = {
  label?: string;
  /** lower first; fields without one follow, in the gestalt's order */
  order?: number;
  /** not shown (another part of the note shows it, or it's internal) */
  hidden?: boolean;
  /** shows and edits the field instead of the default for its type */
  Field?: ComponentType<FieldProps>;
};

/** What a lens's `afterSave` gets: the note before (null when it's new) and as written. */
export type SaveContext = { key: string; before: JsonMap | null; after: JsonMap };

/**
 * How the host's note component shows the notes of one gestalt, a plugin's (`lenses` in `plugin.yml`). Every note
 * shows the lenses of all the gestalts it has or is a candidate for; a field claimed by several shows once.
 */
export type Lens = {
  /** `name@version` */
  gestalt: string;
  /** the group's heading (default: the gestalt's name) */
  title?: string;
  /** higher first among a note's lenses (default 0) */
  priority?: number;
  fields?: Record<string, LensField>;
  /**
   * The fields offered while editing a note, unset ones included (default: all); the others show once set, and can be
   * added. For gestalts with many optional fields of which a note needs few (a source's, by its entry type).
   */
  offered?: (note: JsonMap) => string[];
  /** a new note's value meant to have this gestalt, once its required tags are added (e.g. defaults) */
  seed?: (value: JsonMap) => JsonMap;
  /** one short line about the note in compact and inline views (e.g. an appointment's date) */
  Summary?: ComponentType<{ note: JsonMap }>;
  /** after the note component wrote a note with this gestalt; the repo is the plugin's own (its `access`) */
  afterSave?: (repo: Repo, ctx: SaveContext) => Promise<void>;
};

/** A lens, typed; export it and name it in `plugin.yml` (`lenses: [{gestalt, entry}]`). */
export const defineLens = (lens: Lens): Lens => lens;

/** A lens as the host hands it to the note component: `afterSave` bound to the plugin's repo. */
export type HostLens = Omit<Lens, 'afterSave'> & { afterSave?: (ctx: SaveContext) => Promise<void> };
