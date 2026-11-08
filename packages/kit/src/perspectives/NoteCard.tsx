import type { JsonMap } from '@gestalts/view';
import { useBlobUrls } from '@gestalts/view';
import { Markdown, embedKind } from '../primitives';

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);

export type BlobRef = { file: string; label: string };
export const blobsOf = (value: JsonMap): BlobRef[] => (Array.isArray(value.blobs) ? (value.blobs as BlobRef[]) : []);

/** A `note`, as it reads: only what it has, with no placeholders for the rest. */
export function NoteCard({ value, onOpen }: { value: JsonMap; onOpen?: (id: string) => void }) {
  const [title, main, extra] = [text(value.title), text(value.main), text(value.extra)];
  const blobs = blobsOf(value);
  const urls = useBlobUrls(blobs.map((b) => b.file));
  return (
    <article className="flex flex-col gap-3">
      {title && <h2 className="text-xl font-semibold">{title}</h2>}
      {main && <Markdown text={main} onOpen={onOpen} />}
      {extra && <Markdown text={extra} onOpen={onOpen} className="text-sm text-base-content/70" />}
      {blobs.map((b) => {
        const url = urls[b.file];
        if (!url) return null;
        const kind = embedKind(b.file);
        if (kind === 'image') return <img key={b.file} src={url} alt={b.label} className="max-h-96 rounded-box object-contain" />;
        if (kind === 'video') return <video key={b.file} src={url} controls className="max-h-96 rounded-box" />;
        if (kind === 'audio') return <audio key={b.file} src={url} controls className="w-full" />;
        return <a key={b.file} href={url} download={b.file} className="link text-sm">{b.label}</a>;
      })}
    </article>
  );
}
