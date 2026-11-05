/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { beforeAll, expect, test } from 'vitest';
import init, { WasmRepo, contentHash, type HostStorage } from '../wasm/gestalts.js';

beforeAll(async () => {
  await init({ module_or_path: readFileSync(new URL('../wasm/gestalts_bg.wasm', import.meta.url)) });
});

/** A native app's folder, in memory, counting the calls the core makes. */
function memoryHost() {
  const notes = new Map<string, string>();
  const blobs = new Map<string, Uint8Array>();
  const calls: string[] = [];
  const host: HostStorage = {
    listNotes: async () => { calls.push('listNotes'); return [...notes.keys()]; },
    readNote: async (k) => { calls.push('readNote'); return notes.get(k) ?? null; },
    readNotes: async (ks) => { calls.push('readNotes'); return ks.filter((k) => notes.has(k)).map((k) => [k, notes.get(k)!]); },
    readAllNotes: async () => { calls.push('readAllNotes'); return [...notes]; },
    noteHashes: async () => Object.fromEntries([...notes].map(([k, t]) => [k, contentHash(t)])),
    writeNote: async (k, t) => { calls.push('writeNote'); notes.set(k, t); },
    writeNotes: async (ns) => { ns.forEach(([k, t]) => notes.set(k, t)); },
    deleteNote: async (k) => { notes.delete(k); },
    listBlobs: async () => [...blobs.keys()],
    readBlob: async (n) => blobs.get(n) ?? null,
    writeBlob: async (n, b) => { blobs.set(n, b.slice()); },
    deleteBlob: async (n) => { blobs.delete(n); },
  };
  return { host, notes, blobs, calls };
}

test('a repo over a host storage opens with one read and writes through', async () => {
  const { host, notes, blobs, calls } = memoryHost();
  notes.set('a', 'id: a\ntitle: first\n');
  const repo = await WasmRepo.openWith(host, [], []);
  expect(calls).toEqual(['readAllNotes']);
  expect((repo.get('a') as { value: { title: string } }).value.title).toBe('first');

  await repo.putValue('b', JSON.stringify({ id: 'b', title: 'second' }));
  expect(notes.get('b')).toContain('title: second');
  await repo.writeBlob('x.png', new Uint8Array([1, 2]));
  expect([...blobs.get('x.png')!]).toEqual([1, 2]);
  expect(await repo.readBlob('x.png')).toEqual(new Uint8Array([1, 2]));
  expect(await repo.readBlob('missing.png')).toBeUndefined();

  // the app synced: it changed `a`, and the repo rereads it when told
  notes.set('a', 'id: a\ntitle: from the desktop\n');
  await repo.reindex(['a']);
  expect((repo.get('a') as { value: { title: string } }).value.title).toBe('from the desktop');
});

test('a host that fails says why', async () => {
  const { host } = memoryHost();
  const repo = await WasmRepo.openWith({ ...host, writeNote: () => Promise.reject(new Error('disk full')) }, [], []);
  await expect(repo.putRaw('c', 'id: c\n')).rejects.toThrow('disk full');
});
