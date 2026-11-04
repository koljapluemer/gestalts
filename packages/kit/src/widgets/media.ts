import { asMap, blobs, type IndexedNote, type Json, type Repo } from '@gestalts/sdk';
import { embedKind } from '../primitives';

/**
 * A note's images and videos: the blobs labelled `image` or `video` (as the dsl migration and the attach tool label
 * them), or unlabelled ones that are images or videos by their extension, in the order `blobs` lists them.
 */

export type Media = { file: string; kind: 'image' | 'video' };

export const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const MAX_EDGE = 1920;
const QUALITY = 0.82;
/** sources re-encoded losslessly: screenshots and diagrams */
const LOSSLESS = ['image/png', 'image/bmp'];
/** kept as they are: animation, vectors */
const AS_IS = ['image/gif', 'image/svg+xml'];

export function mediaOf(note: IndexedNote): Media[] {
  return blobs(note).flatMap((b): Media[] => {
    const kind = b.label === 'image' || b.label === 'video' ? b.label : b.label === null ? embedKind(b.target) : null;
    return kind === 'image' || kind === 'video' ? [{ file: b.target, kind }] : [];
  });
}

/** The note's other blobs (a PDF, Typst assets, audio, …), each once. */
export function otherBlobs(note: IndexedNote): { file: string; label: string | null }[] {
  const media = new Set(mediaOf(note).map((m) => m.file));
  const seen = new Set<string>();
  return blobs(note).filter((b) => !media.has(b.target) && !seen.has(b.target) && seen.add(b.target)).map((b) => ({ file: b.target, label: b.label }));
}

/** A content-addressed blob name: the first 16 hex digits of the bytes' sha256, plus the extension. */
export async function blobName(bytes: Uint8Array, ext: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(hash.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('') + (ext ? `.${ext.toLowerCase()}` : '');
}

/** Images and videos among `files`. */
export const isMedia = (f: File) => f.type.startsWith('image/') || f.type.startsWith('video/');

/** Downscaled to at most 1920 px and re-encoded as WebP: losslessly from PNG and BMP, lossily from photos. */
export async function compressImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) { bitmap.close(); throw new Error('This browser cannot draw images (no 2D canvas).'); }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const quality = LOSSLESS.includes(file.type) ? 1 : QUALITY;
  const webp = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
  // Safari can't encode WebP and falls back to PNG; keep whichever came out
  if (!webp) throw new Error(`${file.name || 'The image'} could not be encoded.`);
  return webp;
}

const EXT: Record<string, string> = {
  'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/svg+xml': 'svg',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
};

const extOf = (type: string, name: string) => EXT[type] ?? name.split('.').pop()?.toLowerCase() ?? '';

/** The bytes and blob name a picked file is stored as. */
async function prepare(file: File): Promise<{ name: string; bytes: Uint8Array; kind: Media['kind'] }> {
  if (file.type.startsWith('video/')) {
    if (file.size > MAX_VIDEO_BYTES) throw new Error(`${file.name}: videos can be up to ${MAX_VIDEO_BYTES / 1024 / 1024} MB.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { name: await blobName(bytes, extOf(file.type, file.name)), bytes, kind: 'video' };
  }
  const out = AS_IS.includes(file.type) ? file : await compressImage(file);
  const bytes = new Uint8Array(await out.arrayBuffer());
  return { name: await blobName(bytes, extOf(out.type, file.name)), bytes, kind: 'image' };
}

/**
 * Stores the images and videos among `files` as blobs and lists them in the note's `blobs` (labelled `image` or
 * `video`), after its others. Each file is tried on its own; the errors of the ones that failed are returned.
 */
export async function attachMedia(repo: Repo, key: string, files: File[]): Promise<{ added: string[]; errors: string[] }> {
  const added: { file: string; label: string }[] = [];
  const errors: string[] = [];
  for (const f of files.filter(isMedia)) {
    try {
      const p = await prepare(f);
      await repo.writeBlob(p.name, p.bytes);
      added.push({ file: p.name, label: p.kind });
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (added.length) await updateBlobs(repo, key, (list) => {
    const have = new Set(list.map(fileOf));
    return [...list, ...added.filter((a) => !have.has(a.file))];
  });
  return { added: added.map((a) => a.file), errors };
}

/** Takes a blob off the note's `blobs`. The blob itself stays: blobs are never deleted (another note may use it). */
export async function detachMedia(repo: Repo, key: string, file: string): Promise<void> {
  await updateBlobs(repo, key, (list) => list.filter((b) => fileOf(b) !== file));
}

const fileOf = (b: Json) => (typeof b === 'string' ? b : (asMap(b)?.file ?? null));

async function updateBlobs(repo: Repo, key: string, change: (list: Json[]) => Json[]) {
  const note = repo.get(key);
  const value = asMap(note?.value);
  if (!note || !value) throw new Error(note ? 'The note does not parse; fix its YAML first.' : `No note ${key}`);
  const next: { [k: string]: Json } = { ...value, blobs: change(Array.isArray(value.blobs) ? value.blobs : []) };
  if (!(next.blobs as Json[]).length) delete next.blobs;
  await repo.putValue(key, next);
}
