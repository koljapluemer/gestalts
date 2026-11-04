import init, {
  WasmRepo, bibCitedKeys, bibMatches, bibMerge, bibModel, bibParse, bibUniqueCitekey, bibWrite, cardId as wasmCardId,
  contentHash as wasmContentHash, newId as wasmNewId, stableId as wasmStableId, stateKey as wasmStateKey,
} from '../wasm/gestalts.js';
import {
  ServiceClient, logger, provideNatives, type GestaltDef, type IndexedNote, type Json, type MergeResult, type Query, type Repo as Port,
  type SyncReport, type UpstreamReport,
} from '@gestalts/sdk';
import { coalesce } from './coalesce';

const log = logger('repo');

/** A read-only deck published at `url` (a folder with `index.json`), under its `source` id and earlier ones. */
export type DeckSource = { source: string; aliases?: string[]; url: string };

export type RepoSource = {
  /** the user's notes live in OPFS under `dir` */
  dir: string;
  /** read-only decks under them; a deck note is copied into `dir` once the user's notes reference it */
  decks?: DeckSource[];
  /** gestalt definitions (YAML) beyond the core's, from plugins */
  gestalts?: string[];
};

export type ConnectorStatus = {
  url: string | null;
  state: 'off' | 'syncing' | 'ok' | 'error';
  error?: string;
  lastSync?: Date;
  lastReport?: SyncReport;
  /** `conflict@1` notes recorded since connecting */
  conflicts: string[];
  /** the folder the connector serves, as of the last sync */
  folder?: string;
};

let ready: Promise<unknown> | null = null;

/** The core's ids, hashes and BibTeX, for `@gestalts/sdk`; usable once the wasm is loaded. */
function provideCoreNatives() {
  provideNatives({
    newId: () => wasmNewId(),
    stableId: (ns, name) => wasmStableId(ns, name),
    stateKey: (gestalt, target, facet) => wasmStateKey(gestalt, target, facet),
    cardId: (front) => wasmCardId(front),
    contentHash: (text) => wasmContentHash(text),
    bib: {
      parse: (text) => bibParse(text),
      write: (sources) => bibWrite(sources),
      matches: (entry, existing, limit) => bibMatches(entry, existing, limit),
      merge: (current, incoming, take) => bibMerge(current, incoming, take),
      uniqueCitekey: (key, taken) => bibUniqueCitekey(key, taken),
      citedKeys: (typst) => bibCitedKeys(typst),
      model: () => bibModel(),
    },
  });
}

/**
 * The notes and blobs an app works with, backed by the Rust core.
 * Subscribe to learn about any change (own writes or a sync); `version` increases on each.
 */
export class Repo implements Port {
  private listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  /** mutations queued or running, for the log */
  private pending = 0;
  private blobUrls = new Map<string, Promise<string | null>>();
  private status: ConnectorStatus = { url: null, state: 'off', conflicts: [] };
  private statusListeners = new Set<() => void>();
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  version = 0;
  /**
   * Settles once the first sync after opening is done (or failed), right away without a connector. Seed notes (default
   * panes, installs) only after it, so a new device doesn't recreate what another one deleted.
   */
  firstSync: Promise<void> = Promise.resolve();

  private constructor(private wasm: WasmRepo, private storageKey: string) {}

  static async open(source: RepoSource): Promise<Repo> {
    const span = log.span('open', { dir: source.dir, decks: (source.decks ?? []).map((d) => d.source) });
    let wasm: WasmRepo;
    try {
      ready ??= init().then(provideCoreNatives);
      await ready;
      wasm = await WasmRepo.open(source.dir, source.decks ?? [], source.gestalts ?? []);
    } catch (e) {
      span.fail(e);
      throw e;
    }
    span.end();
    const repo = new Repo(wasm, `gestalts-connector:${source.dir}`);
    let saved: string | null = null;
    try { saved = localStorage.getItem(repo.storageKey); } catch { /* no storage: start disconnected */ }
    repo.firstSync = saved ? repo.connect(saved).catch(() => undefined) : Promise.resolve();
    return repo;
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  };

  private changed() {
    this.version++;
    log.debug('changed', { version: this.version });
    this.listeners.forEach((l) => l());
  }

  /**
   * Runs mutations one at a time, so a sync never interleaves with a write. Logged as a span named `name` from when
   * it starts, with how long it waited behind the ones before it.
   */
  private serial<T>(name: string, f: () => Promise<T>, data?: Record<string, unknown>): Promise<T> {
    const queuedAt = Date.now();
    const ahead = this.pending++;
    if (ahead) log.debug(`${name}: queued`, { ...data, ahead });
    const go = async () => {
      const span = log.span(name, { ...data, waitedMs: Date.now() - queuedAt });
      try {
        const r = await f();
        span.end();
        return r;
      } catch (e) {
        span.fail(e);
        throw e;
      } finally {
        this.pending--;
      }
    };
    const run = this.queue.then(go, go);
    this.queue = run.catch(() => undefined);
    return run;
  }

  query(q: Query = {}): IndexedNote[] {
    return this.wasm.query(q) as IndexedNote[];
  }

  get(key: string): IndexedNote | undefined {
    return (this.wasm.get(key) as IndexedNote | null) ?? undefined;
  }

  /** The key of the note with this `id` (or key). */
  keyOf(id: string): string | undefined {
    return this.wasm.keyOf(id);
  }

  /** For a layered repo: what the last check against upstream (on open, after each sync) did. */
  upstreamReport(): UpstreamReport {
    return this.wasm.upstreamReport() as UpstreamReport;
  }

  gestalts(): GestaltDef[] {
    return this.wasm.gestalts() as GestaltDef[];
  }

  /** Returns undefined while offline. A declared service may still answer 503 while its worker starts. */
  service(id: string): ServiceClient | undefined {
    return this.status.url ? new ServiceClient(this.status.url.replace(/\/$/, ''), id) : undefined;
  }

  /** What `raw` would index as, without saving it. */
  inspect(key: string, raw: string): IndexedNote {
    return this.wasm.inspect(key, raw) as IndexedNote;
  }

  /** What writing `value` under `key` would index as, without saving it. */
  inspectValue(key: string | undefined, value: Json): IndexedNote {
    return this.wasm.inspectValue(key, JSON.stringify(value)) as IndexedNote;
  }

  async putRaw(key: string, raw: string): Promise<IndexedNote> {
    const n = await this.serial('putRaw', () => this.wasm.putRaw(key, raw) as Promise<IndexedNote>, { key });
    this.afterWrite();
    return n;
  }

  /** Without a key, a new uuid becomes key and `id`. */
  async putValue(key: string | undefined, value: Json): Promise<IndexedNote> {
    const n = await this.serial('putValue', () => this.wasm.putValue(key, JSON.stringify(value)) as Promise<IndexedNote>, { key });
    this.afterWrite();
    return n;
  }

  /**
   * Deletes a note: writes its tombstone, so the delete syncs, and the tombstones of notes that die with it (learner
   * state of a deleted card). Returns every key deleted. Writing the note again brings it back.
   */
  async delete(key: string): Promise<string[]> {
    const keys = await this.serial('delete', () => this.wasm.delete(key) as Promise<string[]>, { key });
    this.afterWrite();
    return keys;
  }

  /** The keys of the notes copied from the deck `source` (or one of its `aliases`). */
  copiesOf(source: string, aliases: string[] = []): Promise<string[]> {
    return this.wasm.copiesOf(source, aliases) as Promise<string[]>;
  }

  /** Whether `key` was deleted (is a tombstone); `get` returns nothing for it. */
  isDeleted(key: string): boolean {
    return this.wasm.isDeleted(key);
  }

  /**
   * Three-way merge of one note's text as a sync does it, by the note's gestalts' merge rules. `text` is null when the
   * note is absent; `conflicts` lists what no rule settled (the text keeps one side of each).
   */
  merge3(key: string, base: string | null, local: string | null, remote: string | null): MergeResult {
    return this.wasm.merge3(key, base ?? undefined, local ?? undefined, remote ?? undefined) as MergeResult;
  }

  async readBlob(name: string): Promise<Uint8Array | undefined> {
    return this.wasm.readBlob(name);
  }

  async writeBlob(name: string, bytes: Uint8Array): Promise<void> {
    await this.serial('writeBlob', () => this.wasm.writeBlob(name, bytes), { name, bytes: bytes.length });
    this.blobUrls.delete(name);
    this.afterWrite();
  }

  /** An object URL for a blob, cached; `null` if missing. */
  blobUrl(name: string): Promise<string | null> {
    let url = this.blobUrls.get(name);
    if (!url) {
      url = this.readBlob(name).then((b) => (b ? URL.createObjectURL(new Blob([b as Uint8Array<ArrayBuffer>], { type: mimeOf(name) })) : null));
      this.blobUrls.set(name, url);
    }
    return url;
  }

  private afterWrite() {
    this.changed();
    if (this.status.url) {
      clearTimeout(this.syncTimer);
      this.syncTimer = setTimeout(() => void this.sync(), 800);
    }
  }

  // --- connector ---

  connector = {
    get: () => this.status,
    subscribe: (l: () => void) => {
      this.statusListeners.add(l);
      return () => { this.statusListeners.delete(l); };
    },
  };

  private setStatus(patch: Partial<ConnectorStatus>) {
    this.status = { ...this.status, ...patch };
    this.statusListeners.forEach((l) => l());
  }

  /** Syncs with the connector at `url` now, then after each write and every 15 s. */
  async connect(url: string): Promise<void> {
    log.info('connect', { url });
    try { localStorage.setItem(this.storageKey, url); } catch { /* not remembered */ }
    clearInterval(this.pollTimer);
    this.setStatus({ url, state: 'syncing', error: undefined, conflicts: [] });
    this.pollTimer = setInterval(() => void this.sync(), 15_000);
    await this.sync();
  }

  /** Stops syncing without forgetting the connector, e.g. before opening the same folder again. */
  close() {
    clearInterval(this.pollTimer);
    clearTimeout(this.syncTimer);
    this.setStatus({ url: null, state: 'off' });
  }

  disconnect() {
    log.info('disconnect');
    try { localStorage.removeItem(this.storageKey); } catch { /* nothing remembered */ }
    clearInterval(this.pollTimer);
    clearTimeout(this.syncTimer);
    this.setStatus({ url: null, state: 'off', error: undefined });
  }

  /**
   * Syncs now, or, if a sync is running, once more after it; with one already waiting, joins that one. So syncs never
   * pile up in the write queue (each would make the writes after it wait).
   */
  sync = coalesce(() => this.runSync(), () => log.debug('sync: coalesced'));

  private async runSync(): Promise<SyncReport | undefined> {
    const url = this.status.url;
    if (!url) return;
    this.setStatus({ state: 'syncing' });
    try {
      const report = await this.serial('sync', () => this.wasm.sync(url) as Promise<SyncReport>);
      if (this.status.url !== url) return report;
      log.info('sync done', {
        pushed: report.pushed.length, pulled: report.pulled.length, blobsPulled: report.blobs_pulled.length, conflicts: report.conflicts.length,
        notes: report.notes, timings: report.timings,
      });
      this.setStatus({ state: 'ok', lastSync: new Date(), lastReport: report, folder: report.folder, conflicts: [...this.status.conflicts, ...report.conflicts] });
      const up = this.upstreamReport();
      if (report.pulled.length || report.blobs_pulled.length || report.conflicts.length || up.copied.length || up.updated.length) {
        report.blobs_pulled.forEach((b) => this.blobUrls.delete(b));
        this.changed();
      }
      return report;
    } catch (e) {
      log.error('sync failed', { error: e });
      this.setStatus({ state: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }
}

const MIME: Record<string, string> = {
  webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf',
};

function mimeOf(name: string): string {
  return MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}
