import { stableId, type Repo } from '@gestalts/client';
import type { Item, JsonMap } from '@gestalts/view';

/** One viz is one yml (plugins/vizint/gestalts/viz/v1.yml). */
export const VIZ = 'viz@1';

export type BlobRef = { file: string; label: string };
export type Viz = {
  id: string; title: string; intro: string; spec: string; outro: string; source: string; packages: string[];
  files: BlobRef[]; built?: string; still?: string; generator?: string;
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const refs = (v: unknown): BlobRef[] => (Array.isArray(v)
  ? v.filter((x): x is BlobRef => !!x && typeof x === 'object' && typeof x.file === 'string' && typeof x.label === 'string')
  : []);

export function asViz(i: Item): Viz {
  const v = i.value;
  return {
    id: i.id, title: str(v.title), intro: str(v.intro), spec: str(v.spec), outro: str(v.outro), source: str(v.source),
    packages: strings(v.packages), files: refs(v.files),
    built: str(v.built) || undefined, still: str(v.still) || undefined, generator: str(v.generator) || undefined,
  };
}

/** The yml for `v`, leaving out what's empty (an empty prop is still a prop). */
export function ymlOf(v: Viz): JsonMap {
  const out: JsonMap = { id: v.id, gestalt: VIZ, title: v.title || 'Untitled' };
  for (const k of ['intro', 'spec', 'outro', 'source', 'built', 'still', 'generator'] as const) if (v[k]) out[k] = v[k];
  if (v.packages.length) out.packages = v.packages;
  if (v.files.length) out.files = v.files;
  return out;
}

export const saveViz = (repo: Repo, v: Viz) => repo.put(ymlOf(v));

export async function createViz(repo: Repo, title: string): Promise<string> {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'viz';
  const id = `viz-${slug}-${stableId('viz', `${title}:${Date.now()}`).slice(0, 8)}`;
  await saveViz(repo, { id, title, intro: '', spec: '', outro: '', source: '', packages: [], files: [] });
  return id;
}

/** Stores `bytes` as a blob named by its content, as published decks name them. */
export async function storeBlob(repo: Repo, bytes: Uint8Array, ext: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  const name = `${Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')}.${ext}`;
  await repo.writeBlob(name, bytes);
  return name;
}

export const toBase64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
export const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
