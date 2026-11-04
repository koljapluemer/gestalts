import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import { Camera, ChevronLeft, ChevronRight, ImageOff, Maximize2, Upload, X } from 'lucide-react';
import { useBlobUrl } from '@gestalts/sdk';
import { isMedia, type Media } from './media';

type Props = {
  media: Media[];
  /** given: each can be taken off the note, from the enlarged view */
  onRemove?: (file: string) => void;
};

/**
 * A note's images and videos: one at full width, more in a row scrolled sideways (swiped on touch). Enlarging one
 * opens a viewer that steps through all of them (arrow buttons, ←/→).
 */
export function MediaGallery({ media, onRemove }: Props) {
  const [open, setOpen] = useState<number | null>(null);
  if (!media.length) return null;
  const shown = open === null ? null : Math.min(open, media.length - 1);
  return (
    <>
      {media.length === 1
        ? <Item m={media[0]} className="max-h-[60vh] w-full object-contain" onEnlarge={() => setOpen(0)} />
        : (
          <div className="relative">
            <div className="carousel carousel-center w-full gap-2 rounded-box">
              {media.map((m, i) => (
                <div key={m.file} className="carousel-item">
                  <Item m={m} className="h-48 w-auto max-w-[80vw] object-contain" onEnlarge={() => setOpen(i)} />
                </div>
              ))}
            </div>
            <span className="badge badge-sm badge-neutral absolute right-2 bottom-2 opacity-80">{media.length}</span>
          </div>
        )}
      {shown !== null && <Viewer media={media} at={shown} onAt={setOpen} onClose={() => setOpen(null)} onRemove={onRemove} />}
    </>
  );
}

function Item({ m, className, onEnlarge }: { m: Media; className: string; onEnlarge: () => void }) {
  const url = useBlobUrl(m.file);
  if (!url) return <div className={`skeleton ${className} min-h-24 min-w-32`} />;
  return (
    <div className="group relative">
      {m.kind === 'image'
        ? <button type="button" className="block cursor-zoom-in" onClick={onEnlarge} title="Enlarge"><img src={url} alt="" className={`rounded-box ${className}`} /></button>
        // oxlint-disable-next-line jsx-a11y/media-has-caption -- a note's own recordings have no captions
        : <video src={url} controls preload="metadata" className={`rounded-box ${className}`} />}
      {m.kind === 'video' && (
        <button type="button" className="btn btn-xs btn-circle absolute top-2 right-2 opacity-80" onClick={onEnlarge} title="Enlarge">
          <Maximize2 className="size-3" />
        </button>
      )}
    </div>
  );
}

function Viewer({ media, at, onAt, onClose, onRemove }: {
  media: Media[];
  at: number;
  onAt: (i: number) => void;
  onClose: () => void;
  onRemove?: (file: string) => void;
}) {
  const m = media[at];
  const url = useBlobUrl(m.file);
  const step = (d: number) => onAt((at + d + media.length) % media.length);
  const keys = useRef({ step, onClose });
  useEffect(() => { keys.current = { step, onClose }; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') keys.current.step(-1);
      else if (e.key === 'ArrowRight') keys.current.step(1);
      else if (e.key === 'Escape') { e.stopPropagation(); keys.current.onClose(); }
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  // in a portal: a note shown in a modal sits in a transformed box, which would trap a fixed element
  return createPortal(
    <div className="fixed inset-0 z-[1000] flex flex-col bg-black/90" role="dialog" aria-modal="true" aria-label="Media">
      <div className="flex items-center gap-2 p-2 text-white">
        <span className="flex-1 text-sm opacity-70">{at + 1} / {media.length}</span>
        {onRemove && (
          <button type="button" className="btn btn-sm btn-ghost text-white" title="Take it off this note"
                  onClick={() => { if (confirm('Take this off the note?')) { onRemove(m.file); if (media.length === 1) onClose(); } }}>
            <ImageOff className="size-4" /> Remove
          </button>
        )}
        <button type="button" className="btn btn-sm btn-ghost btn-square text-white" title="Close" onClick={onClose}><X className="size-5" /></button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-2">
        {url && (m.kind === 'image'
          ? <img src={url} alt="" className="max-h-full max-w-full object-contain" />
          // oxlint-disable-next-line jsx-a11y/media-has-caption -- a note's own recordings have no captions
          : <video key={url} src={url} controls autoPlay className="max-h-full max-w-full" />)}
        {media.length > 1 && (
          <>
            <button type="button" className="btn btn-circle btn-ghost absolute left-2 text-white" title="Previous (←)" onClick={() => step(-1)}><ChevronLeft className="size-6" /></button>
            <button type="button" className="btn btn-circle btn-ghost absolute right-2 text-white" title="Next (→)" onClick={() => step(1)}><ChevronRight className="size-6" /></button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Icon buttons picking images and videos: upload (any number) and, on touch screens, the camera. */
export function MediaPicker({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const upload = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const picked = (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])].filter(isMedia);
    // reset, so picking the same file again still fires
    e.target.value = '';
    if (files.length) onFiles(files);
  };
  return (
    <>
      <input ref={upload} type="file" accept="image/*,video/*" multiple className="hidden" onChange={picked} />
      {/* `capture` opens the camera app on phones; desktops ignore it, hence the button shows on touch screens only */}
      <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" onChange={picked} />
      <button type="button" className="btn btn-ghost btn-xs btn-square" title="Attach images or videos" disabled={disabled} onClick={() => upload.current?.click()}>
        <Upload className="size-4" />
      </button>
      <button type="button" className="btn btn-ghost btn-xs btn-square hidden pointer-coarse:inline-flex" title="Take a photo" disabled={disabled}
              onClick={() => camera.current?.click()}>
        <Camera className="size-4" />
      </button>
    </>
  );
}
