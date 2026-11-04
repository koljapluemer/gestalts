/** Shapes handed out by the core (see crates/core). */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type ParseError = { message: string; line: number | null; column: number | null };

export type Lint = {
  /** `name@version` */
  gestalt: string;
  /** e.g. `card.dueAt`, `blobs.audio`; empty for the whole note */
  path: string;
  message: string;
};

export type IndexedNote = {
  /** file name without `.yml` */
  key: string;
  /** the `id` field, else the key */
  id: string;
  raw: string;
  /** the parsed YAML, if it parses */
  value: Json | null;
  parse_error: ParseError | null;
  /** `name@version` of every gestalt the note has */
  gestalts: string[];
  lints: Lint[];
};

export type Query = {
  /** `name@version` */
  gestalt?: string;
  /** `name@version` of gestalts the note must not have */
  gestaltsNone?: string[];
  tagsAll?: string[];
  tagsNone?: string[];
  keys?: string[];
  /** Exact matches on top-level scalar fields. */
  where?: Record<string, string | number | boolean | null>;
};

export type GestaltDef = {
  name: string;
  version: number;
  description: string | null;
  requires_tags: string[];
  trigger_fields: string[];
  fields: Record<string, unknown>;
  blobs: Record<string, { min: number | null; max: number | null }>;
  relationships: Record<string, { min: number | null; max: number | null }>;
};

export type SyncReport = {
  pulled: string[];
  pushed: string[];
  conflicts: string[];
  blobs_pulled: string[];
  blobs_pushed: string[];
  /** the connector's open folder */
  folder: string;
  /** unreferenced blobs deleted after the sync, here and in the folder */
  blobs_collected?: { local: string[]; remote: string[] };
  /** how many notes each side had: local, remote, base */
  notes?: { local: number; remote: number; base: number };
  /** ms per step of the sync, for the debug log */
  timings?: Record<string, number>;
};

/** What checking a layered repo against its upstream did, by note key. */
export type UpstreamReport = {
  /** copied into user space because something there referenced them */
  copied: string[];
  /** untouched copies fast-forwarded to a changed upstream */
  updated: string[];
  /** edited copies whose upstream changed; left as they are */
  diverged: string[];
};

export type Ref = { target: string; label: string | null };
