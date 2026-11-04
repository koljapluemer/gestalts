import type { GestaltDef, IndexedNote, Json, Query, UpstreamReport } from './types';

/** A versioned optional HTTP service exposed by a connector-hosted plugin. */
export class ServiceClient {
  constructor(readonly baseUrl: string, readonly id: string) {}

  request(path = '', init?: RequestInit): Promise<Response> {
    const suffix = path.replace(/^\//, '');
    return fetch(`${this.baseUrl}/services/${encodeURIComponent(this.id)}/${suffix}`, init);
  }
}

/** What `Repo.merge3` gives. */
export type MergeResult = { text: string | null; conflicts: Json[]; raw: boolean };

/**
 * The notes and blobs a perspective works with, as the host hands them out. Notes cross it parsed (`value`); only the
 * host's core parses YAML. Subscribe to learn about any change; `version` increases on each.
 * Writes are checked against the perspective's declared `access` and linted against the gestalts; refused ones throw.
 */
export interface Repo {
  readonly version: number;
  subscribe(listener: () => void): () => void;
  query(q?: Query): IndexedNote[];
  get(key: string): IndexedNote | undefined;
  /** The key of the note with this `id` (or key). */
  keyOf(id: string): string | undefined;
  /** Whether `key` was deleted (is a tombstone); `get` returns nothing for it. */
  isDeleted(key: string): boolean;
  gestalts(): GestaltDef[];
  /** For a layered repo: what the last check against its decks did. */
  upstreamReport(): UpstreamReport;
  /** Undefined while there's no connector. A declared service may still answer 503 while its worker starts. */
  service(id: string): ServiceClient | undefined;
  /** What `raw` would index as, without saving it. */
  inspect(key: string, raw: string): IndexedNote;
  /** Three-way merge of one note's text as a sync does it, by its gestalts' merge rules. */
  merge3(key: string, base: string | null, local: string | null, remote: string | null): MergeResult;
  putRaw(key: string, raw: string): Promise<IndexedNote>;
  /** Without a key, a new uuid becomes key and `id`. */
  putValue(key: string | undefined, value: Json): Promise<IndexedNote>;
  /** Writes the note's tombstone (and those of notes that die with it); returns every key deleted. */
  delete(key: string): Promise<string[]>;
  readBlob(name: string): Promise<Uint8Array | undefined>;
  writeBlob(name: string, bytes: Uint8Array): Promise<void>;
  /** An object URL for a blob, cached; `null` if missing. */
  blobUrl(name: string): Promise<string | null>;
}
