import { tags, type IndexedNote, type Json, type Repo } from '@gestalts/sdk';
import type { Scope } from './registry';

function inScope(n: IndexedNote, s: Scope | undefined): boolean {
  if (s === 'all') return true;
  if (!s) return false;
  return (s.gestalts ?? []).some((g) => n.gestalts.includes(g)) || (!!s.tags_all?.length && s.tags_all.every((t) => tags(n).includes(t)));
}

/** A write outside a plugin's `access`. */
export class AccessError extends Error {}

/**
 * The repo as a plugin with this `access` sees it: it reads only notes in `access.read`, and writes only notes that
 * are (before and after) in `access.write`. A write scoped by gestalt must give a note that has the gestalt, so
 * notes that break its rules are refused too. First-party plugins get the same scoped port.
 */
export function scopedRepo(repo: Repo & { inspectValue(key: string | undefined, value: Json): IndexedNote }, plugin: string, access: { read?: Scope; write?: Scope } = {}): Repo {
  const read = access.read ?? 'all';
  const write = access.write;
  if (read === 'all' && write === 'all') return repo;
  const refuse = (key: string | undefined, what: string): never => { throw new AccessError(`${plugin} may not ${what} ${key ?? 'a new note'}`); };
  const checkExisting = (key: string | undefined) => {
    const old = key ? repo.get(key) : undefined;
    if (old && !inScope(old, write)) refuse(key, 'change');
  };
  return {
    get version() { return repo.version; },
    subscribe: (l) => repo.subscribe(l),
    query: (q) => repo.query(q).filter((n) => inScope(n, read)),
    get: (key) => { const n = repo.get(key); return n && inScope(n, read) ? n : undefined; },
    keyOf: (id) => repo.keyOf(id),
    isDeleted: (key) => repo.isDeleted(key),
    gestalts: () => repo.gestalts(),
    upstreamReport: () => repo.upstreamReport(),
    service: (id) => repo.service(id),
    inspect: (key, raw) => repo.inspect(key, raw),
    merge3: (key, b, l, r) => repo.merge3(key, b, l, r),
    putRaw: async (key, raw) => {
      checkExisting(key);
      if (!inScope(repo.inspect(key, raw), write)) refuse(key, 'write');
      return repo.putRaw(key, raw);
    },
    putValue: async (key, value) => {
      checkExisting(key);
      if (!inScope(repo.inspectValue(key, value), write)) refuse(key, 'write');
      return repo.putValue(key, value);
    },
    delete: async (key) => {
      const old = repo.get(key);
      if (old && !inScope(old, write)) refuse(key, 'delete');
      return repo.delete(key);
    },
    readBlob: (name) => repo.readBlob(name),
    writeBlob: (name, bytes) => repo.writeBlob(name, bytes),
    blobUrl: (name) => repo.blobUrl(name),
  };
}
