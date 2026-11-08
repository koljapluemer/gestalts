import { logger, type Delta, type Health, type Item, type JsonMap, type Page, type Query } from '@gestalts/view';
import init, { WasmRepo, contentHash as wasmContentHash, newId as wasmNewId, stableId as wasmStableId, stateId as wasmStateId } from '../wasm/gestalts.js';
import { coalesce } from './coalesce';
import { nativeHost, type NativeHost, type NativeKind, type NativeStatus, type PairedNodeInfo } from './native';

const log = logger('repo');

/** A read-only deck published at `url` (a folder with `index.json`), under its `source` id. */
export type DeckSource = { source: string; url: string };

/** Where the user's notes live: in OPFS under `dir` (synced with a connector, if one is set), in the folder the
 * node at `node` serves (the desktop app; written directly, nothing to sync), or in the folder of the native app
 * around the page (`native`: Android), which syncs it with the node it paired with. */
export type YmlsIn =
  | { dir: string; node?: undefined; native?: undefined }
  | { node: string; dir?: undefined; native?: undefined }
  | { native: NativeKind; dir?: undefined; node?: undefined };

export type RepoSource = YmlsIn & {
  /** read-only decks under them */
  decks?: DeckSource[];
  /** gestalt definitions (YAML) beyond the core's, from plugins */
  gestalts?: string[];
};

/** One of a node's `/services`: `available` while its worker runs. */
export type ServiceStatus = { id: string; available: boolean };

/** A node's `/health`. */
export type NodeHealth = { app: string; version: string; folder: { id: string; path: string } | null };

/** Asks the node at `url` who it is and which folder it serves; throws if no node answers. */
export async function nodeHealth(url: string): Promise<NodeHealth> {
  const r = await fetch(new URL('health', withSlash(url)));
  if (!r.ok) throw new Error(`no node at ${url} (${r.status})`);
  return (await r.json()) as NodeHealth;
}

function withSlash(url: string) {
  return url.endsWith('/') ? url : `${url}/`;
}

/** How long to wait before reconnecting to a node's change events, growing with each failure. */
const RECONNECT_MS = [500, 1000, 2000, 5000];

export type ConnectorStatus = {
  /**
   * `sync`: notes in this browser, synced with the connector at `url`; `direct`: the notes are the node's folder;
   * `paired`: the notes are a native app's, which syncs them with the node it paired with (`node`, no `url`)
   */
  mode: 'sync' | 'direct' | 'paired';
  url: string | null;
  state: 'off' | 'syncing' | 'ok' | 'error';
  error?: string;
  lastSync?: Date;
  lastReport?: SyncReport;
  /** `conflict@1` ymls recorded since connecting */
  conflicts: string[];
  /** the folder the connector serves, as of the last sync (direct: as of opening) */
  folder?: string;
  /** paired: the node, if the app is paired with one */
  node?: PairedNodeInfo;
};

export type SyncReport = {
  pulled: string[];
  pushed: string[];
  conflicts: string[];
  blobs_pulled: string[];
  blobs_pushed: string[];
  /** the connector's open folder */
  folder: string;
  blobs_collected?: { local: string[]; remote: string[] };
  /** how many ymls each side had: local, remote, base */
  notes?: { local: number; remote: number; base: number };
  /** how many ymls differed, so their texts were read and merged */
  compared?: number;
  /** ms per step of the sync, for the debug log */
  timings?: Record<string, number>;
};

/** A gestalt definition, as the core has it. */
export type GestaltDef = { name: string; version: number; description: string | null; fields: Record<string, unknown>; merge?: unknown };

let ready: Promise<unknown> | null = null;

/** Loads the core. Everything below needs it; opening a repo does it. */
export async function loadCore(): Promise<void> {
  ready ??= init();
  await ready;
}

/** A fresh uuid. */
export const newId = () => wasmNewId();
/** The same id for the same `name` within `namespace`. */
export const stableId = (namespace: string, name: string) => wasmStableId(namespace, name);
/** The id of a learner-state yml for `target`, or one `facet` of it. */
export const stateId = (gestalt: string, target: string, facet?: string) => wasmStateId(gestalt, target, facet);
/** Hex sha256 of a text. */
export const contentHash = (text: string) => wasmContentHash(text);

/** The query as the core reads it: JSON text, without anything left undefined. */
const asJson = (q: Query) => JSON.stringify(q);

/** A running live query. */
export type Live = { page: Page; stop: () => void };

/**
 * The ymls and blobs an app works with, backed by the Rust core. Views never touch this: they go through the bridge.
 * A live query (`live`) hears about the changes that concern it, and nothing else.
 */
export class Repo {
  private queue: Promise<unknown> = Promise.resolve();
  /** mutations queued or running, for the log */
  private pending = 0;
  private lives = new Map<number, (d: Delta) => void>();
  private blobListeners = new Set<(names: string[]) => void>();
  private status: ConnectorStatus = { mode: 'sync', url: null, state: 'off', conflicts: [] };
  private statusListeners = new Set<() => void>();
  private syncTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  /** direct mode: the node's change events */
  private events: WebSocket | undefined;
  /** paired mode: the native app, and what to undo on closing */
  private native: { host: NativeHost; stop: (() => void)[] } | undefined;
  private closed = false;
  /**
   * Settles once the first sync after opening is done (or failed), right away without a connector. Seed ymls (installs)
   * only after it, so a new device doesn't recreate what another one deleted.
   */
  firstSync: Promise<void> = Promise.resolve();

  private constructor(private wasm: WasmRepo, private storageKey: string) {}

  static async open(source: RepoSource): Promise<Repo> {
    const span = log.span('open', { dir: source.dir, decks: (source.decks ?? []).map((d) => d.source) });
    let wasm: WasmRepo;
    try {
      await loadCore();
      if (source.native !== undefined) {
        const host = await nativeHost(source.native);
        await host.setGestalts(source.gestalts ?? []);
        wasm = await WasmRepo.openWith(host, source.decks ?? [], source.gestalts ?? []);
        span.end();
        return await Repo.paired(wasm, host);
      }
      wasm = source.node !== undefined
        ? await WasmRepo.openNode(source.node, source.decks ?? [], source.gestalts ?? [])
        : await WasmRepo.open(source.dir, source.decks ?? [], source.gestalts ?? []);
    } catch (e) {
      span.fail(e);
      throw e;
    }
    span.end();
    if (source.node !== undefined) return Repo.direct(wasm, source.node);
    const repo = new Repo(wasm, `gestalts-connector:${source.dir}`);
    let saved: string | null = null;
    try { saved = localStorage.getItem(repo.storageKey); } catch { /* no storage: start disconnected */ }
    repo.firstSync = saved ? repo.connect(saved).catch(() => undefined) : Promise.resolve();
    return repo;
  }

  /** A repo on the node's folder: no sync; the node's change events keep it current. */
  private static async direct(wasm: WasmRepo, url: string): Promise<Repo> {
    const repo = new Repo(wasm, '');
    let folder: string | undefined;
    try { folder = (await nodeHealth(url)).folder?.path; } catch { /* it answered a moment ago; the events will tell */ }
    repo.setStatus({ mode: 'direct', url, state: 'ok', folder });
    repo.listen(0);
    void wasm.collectNodeBlobs().catch((e: unknown) => log.warn('collecting blobs failed', { error: e }));
    return repo;
  }

  /**
   * A repo on a native app's folder: the app syncs it and says what changed. Only visible pages sync on a timer. If
   * the app is paired, `firstSync` waits for its first sync (or failure).
   */
  private static async paired(wasm: WasmRepo, host: NativeHost): Promise<Repo> {
    const repo = new Repo(wasm, '');
    const native: { host: NativeHost; stop: (() => void)[] } = { host, stop: [] };
    repo.native = native;
    repo.setStatus(nativeStatus(await host.status()));
    let synced: () => void = () => {};
    const first = new Promise<void>((resolve) => { synced = resolve; });
    native.stop.push(await host.onChanged((c) => void repo.reindex(c.ymls, c.blobs)));
    native.stop.push(await host.onStatus((s) => {
      repo.setStatus(nativeStatus(s));
      if (s.state !== 'syncing') synced();
    }));
    const visible = () => void host.setActive(document.visibilityState === 'visible').catch((e: unknown) => log.warn('telling the app failed', { error: e }));
    document.addEventListener('visibilitychange', visible);
    native.stop.push(() => document.removeEventListener('visibilitychange', visible));
    visible();
    if (repo.status.node) {
      repo.firstSync = Promise.race([first, new Promise<void>((r) => setTimeout(r, 20_000))]);
      void host.sync();
    }
    return repo;
  }

  /** Direct mode: follows the node's change events, reconnecting after `failures` failed attempts. */
  private listen(failures: number) {
    const url = this.status.url;
    if (!url || this.closed) return;
    const ws = new WebSocket(new URL('events', withSlash(url)).href.replace(/^http/, 'ws'));
    this.events = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      // changes while we weren't listening are unknown: reread everything
      if (failures > 0 || this.status.state === 'error') void this.reload();
      this.setStatus({ state: 'ok', error: undefined });
    };
    ws.onmessage = (m) => {
      let event: { changed?: { ymls: string[]; blobs: string[] }; folder?: unknown } | 'reload';
      try { event = JSON.parse(String(m.data)) as typeof event; } catch { return; }
      if (event === 'reload') void this.reload();
      else if (event.changed) void this.reindex(event.changed.ymls, event.changed.blobs);
      // another folder: everything the app holds (installs, decks, panes) belongs to the old one
      else if ('folder' in event) location.reload();
    };
    ws.onclose = () => {
      if (this.events !== ws || this.closed) return;
      this.setStatus({ state: 'error', error: 'The gestalter desktop app isn\'t running.' });
      const next = opened ? 0 : failures + 1;
      setTimeout(() => this.listen(next), RECONNECT_MS[Math.min(next, RECONNECT_MS.length - 1)]);
    };
  }

  private async reindex(ymls: string[], blobs: string[]) {
    try {
      if (ymls.length) await this.serial('reindex', () => this.wasm.reindex(ymls), { ymls: ymls.length });
      this.pump();
      if (blobs.length) this.blobListeners.forEach((l) => l(blobs));
    } catch (e) {
      log.warn('rereading changed ymls failed', { error: e });
    }
  }

  private async reload() {
    try {
      await this.serial('reload', () => this.wasm.reload());
      this.pump();
    } catch (e) {
      log.warn('rereading the folder failed', { error: e });
    }
  }

  /** Hands the core's deltas to the live queries they're for. */
  private pump() {
    for (const d of this.wasm.takeDeltas() as Delta[]) this.lives.get(d.sub)?.(d);
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

  /** One page of what `q` asks for. */
  query(q: Query): Page {
    return this.wasm.query(asJson(q)) as Page;
  }

  /** The yml, if it's valid. */
  get(id: string): Item | undefined {
    return (this.wasm.get(id) as Item | null) ?? undefined;
  }

  /** Whether `id` was deleted (is a tombstone); `get` returns nothing for it. */
  isDeleted(id: string): boolean {
    return (this.wasm.isDeleted(id));
  }

  /** The first page of `q`, then `onDelta` with each change to it, until `stop`. */
  live(q: Query, onDelta: (d: Delta) => void): Live {
    const { sub, page } = this.wasm.subscribe(asJson(q)) as { sub: number; page: Page };
    this.lives.set(sub, onDelta);
    return { page, stop: () => { this.lives.delete(sub); this.wasm.unsubscribe(sub); } };
  }

  /** Every yml that can't be used, and why. */
  health(): Health[] {
    return this.wasm.health() as Health[];
  }

  gestalts(): GestaltDef[] {
    return this.wasm.gestalts() as GestaltDef[];
  }

  /** Calls `f` with the names of blobs that changed outside this repo. */
  onBlobsChanged(f: (names: string[]) => void): () => void {
    this.blobListeners.add(f);
    return () => { this.blobListeners.delete(f); };
  }

  /** Answers a request to the backend of plugin `id`; `undefined` where this app has no node. */
  service(id: string, path: string, init?: RequestInit): Promise<Response> | undefined {
    if (!this.status.url || this.status.mode === 'paired') return undefined;
    return fetch(`${withSlash(this.status.url)}services/${encodeURIComponent(id)}/${path.replace(/^\//, '')}`, init);
  }

  /** The backends the node offers and whether each is running; null without a node, or if it didn't answer. */
  async services(): Promise<ServiceStatus[] | null> {
    const url = this.status.url;
    if (!url || this.status.mode === 'paired') return null;
    try {
      const r = await fetch(new URL('services', withSlash(url)));
      return r.ok ? ((await r.json()) as ServiceStatus[]) : null;
    } catch {
      return null;
    }
  }

  /** Refused unless `value` is valid by the gestalt it names. Without an `id`, it gets a new one. */
  async put(value: JsonMap): Promise<Item> {
    const item = await this.serial('put', () => this.wasm.put(JSON.stringify(value)) as Promise<Item>, { id: value.id });
    this.afterWrite();
    return item;
  }

  /** Writes the yml's tombstone, so the delete syncs. Writing it again brings it back. */
  async delete(id: string): Promise<boolean> {
    const deleted = await this.serial('delete', () => this.wasm.delete(id), { id });
    this.afterWrite();
    return deleted;
  }

  async readBlob(name: string): Promise<Uint8Array | undefined> {
    return this.wasm.readBlob(name);
  }

  async writeBlob(name: string, bytes: Uint8Array): Promise<void> {
    await this.serial('writeBlob', () => this.wasm.writeBlob(name, bytes), { name, bytes: bytes.length });
    this.afterWrite();
  }

  private afterWrite() {
    this.pump();
    if (this.status.mode === 'sync' && this.status.url) {
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
    if (this.status.mode !== 'sync') return;
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
    this.closed = true;
    this.events?.close();
    this.native?.stop.forEach((f) => f());
    this.setStatus({ url: null, state: 'off' });
  }

  disconnect() {
    if (this.status.mode !== 'sync') return;
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
    // the native app syncs on its own; its status events tell how it went
    if (this.native) return void (await this.native.host.sync().catch((e: unknown) => log.warn('asking the app to sync failed', { error: e })));
    const url = this.status.url;
    if (!url || this.status.mode === 'direct') return;
    this.setStatus({ state: 'syncing' });
    try {
      // only the merge waits in the write queue; the network parts run alongside the app's writes
      await this.wasm.syncFetch(url);
      const merged = await this.serial('sync', () => this.wasm.syncMerge());
      if (merged.length && this.status.url === url) this.pump();
      const report = (await this.wasm.syncPush()) as SyncReport;
      if (this.status.url !== url) return report;
      log.info('sync done', {
        pushed: report.pushed.length, pulled: report.pulled.length, blobsPulled: report.blobs_pulled.length, conflicts: report.conflicts.length,
        notes: report.notes, compared: report.compared, timings: report.timings,
      });
      this.setStatus({ state: 'ok', lastSync: new Date(), lastReport: report, folder: report.folder, conflicts: [...this.status.conflicts, ...report.conflicts] });
      if (report.blobs_pulled.length) this.blobListeners.forEach((l) => l(report.blobs_pulled));
      return report;
    } catch (e) {
      log.error('sync failed', { error: e });
      this.setStatus({ state: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }
}

function nativeStatus(s: NativeStatus): Partial<ConnectorStatus> {
  return {
    mode: 'paired',
    url: null,
    node: s.paired ?? undefined,
    state: s.state,
    error: s.error ?? undefined,
    lastSync: s.lastSync === null ? undefined : new Date(s.lastSync),
    lastReport: (s.lastReport ?? undefined) as SyncReport | undefined,
    folder: s.folder ?? undefined,
    conflicts: s.conflicts,
  };
}
