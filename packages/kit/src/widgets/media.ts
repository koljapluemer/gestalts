import { embedKind } from '../primitives';

/** Turning picked files into blobs: photos made smaller, everything named by its content. */

export const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const MAX_EDGE = 1920;
const QUALITY = 0.82;
/** sources re-encoded losslessly: screenshots and diagrams */
const LOSSLESS = ['image/png', 'image/bmp'];
/** kept as they are: animation, vectors */
const AS_IS = ['image/gif', 'image/svg+xml'];

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
  if (!webp) throw new Error(`${file.name || 'The image'} could not be encoded.`);
  return webp;
}

const EXT: Record<string, string> = {
  'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/svg+xml': 'svg',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'application/pdf': 'pdf',
};

const extOf = (type: string, name: string) => EXT[type] ?? (name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '');

export type BlobWriter = { writeBlob(name: string, bytes: Uint8Array): Promise<null>; contentHash(bytes: Uint8Array): Promise<string> };

/** What a blob of this name is labelled by default: `image`, `video`, or `file`. */
export const defaultLabel = (name: string): string => embedKind(name);

/**
 * Stores `file` as a blob named by its content (images made smaller first), and returns its `{file, label}`.
 * `write` is `useWrite()`.
 */
export async function storeFile(write: BlobWriter, file: File): Promise<{ file: string; label: string }> {
  if (file.type.startsWith('video/') && file.size > MAX_VIDEO_BYTES) throw new Error(`${file.name}: videos can be up to ${MAX_VIDEO_BYTES / 1024 / 1024} MB.`);
  const shrink = file.type.startsWith('image/') && !AS_IS.includes(file.type);
  const out = shrink ? await compressImage(file) : file;
  const bytes = new Uint8Array(await out.arrayBuffer());
  const ext = extOf(out.type, file.name);
  const name = (await write.contentHash(bytes)).slice(0, 16) + (ext ? `.${ext}` : '');
  await write.writeBlob(name, bytes);
  return { file: name, label: defaultLabel(name) };
}
