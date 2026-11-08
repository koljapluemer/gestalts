import { useState } from 'react';
import { Paperclip, X } from 'lucide-react';
import { Modal, storeFile, type BlobRef } from '@gestalts/kit';
import { useWrite } from '@gestalts/view';

/** One box: type, attach what belongs to it, save. Everything else about a note can wait. */
export default function QuickNote() {
  const write = useWrite();
  const [main, setMain] = useState('');
  const [blobs, setBlobs] = useState<BlobRef[]>([]);
  const [picking, setPicking] = useState(false);
  const [status, setStatus] = useState<{ error?: string; saved?: boolean }>({});
  const [busy, setBusy] = useState(false);

  const attach = async (files: FileList | null) => {
    setBusy(true);
    const stored: BlobRef[] = [];
    const errors: string[] = [];
    for (const f of Array.from(files ?? [])) {
      try { stored.push(await storeFile(write, f)); } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
    }
    setBlobs((b) => [...b, ...stored.filter((s) => !b.some((x) => x.file === s.file))]);
    setStatus(errors.length ? { error: errors.join('\n') } : {});
    setBusy(false);
    if (!errors.length) setPicking(false);
  };

  const save = async () => {
    setBusy(true);
    try {
      await write.put({ gestalt: 'note@1', ...(main.trim() ? { main } : {}), ...(blobs.length ? { blobs } : {}) });
      setMain('');
      setBlobs([]);
      setStatus({ saved: true });
    } catch (e) {
      setStatus({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const empty = !main.trim() && !blobs.length;
  return (
    <div className="mx-auto flex h-full w-full max-w-xl flex-col gap-3 p-4">
      <textarea
        autoFocus
        className="textarea min-h-40 w-full flex-1 text-base"
        placeholder="What's on your mind?"
        value={main}
        onChange={(e) => { setMain(e.target.value); setStatus({}); }}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !empty) void save(); }}
      />
      {blobs.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {blobs.map((b) => (
            <li key={b.file} className="badge gap-1">
              {b.label}
              <button type="button" aria-label="Remove" onClick={() => setBlobs(blobs.filter((x) => x !== b))}><X className="size-3" /></button>
            </li>
          ))}
        </ul>
      )}
      {status.error && <div role="alert" className="alert alert-error text-sm whitespace-pre-wrap">{status.error}</div>}
      {status.saved && <p role="status" className="text-sm text-success">Saved.</p>}
      <div className="flex justify-between gap-2">
        <button type="button" className="btn btn-ghost" onClick={() => setPicking(true)}><Paperclip className="size-4" /> Attach</button>
        <button type="button" className="btn btn-primary" disabled={busy || empty} onClick={() => void save()}>Save</button>
      </div>
      {picking && (
        <Modal onClose={() => setPicking(false)}>
          <div className="flex flex-col gap-3 p-4">
            <h2 className="font-semibold">Attach files</h2>
            <input type="file" multiple className="file-input w-full" disabled={busy} onChange={(e) => void attach(e.target.files)} />
            {busy && <span className="loading loading-spinner" />}
          </div>
        </Modal>
      )}
    </div>
  );
}
