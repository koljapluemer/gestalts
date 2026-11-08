import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useQuery, useWrite, type Item, type JsonMap } from '@gestalts/view';
import { MarkdownEditor } from '../primitives';
import { storeFile } from '../widgets';
import { blobsOf, type BlobRef } from './NoteCard';

type Relationship = { to: string; label: string };
type Draft = { title: string; main: string; extra: string; aliases: string; tags: string; relationships: Relationship[]; blobs: BlobRef[] };

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(', ') : '');
const split = (s: string) => [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))];

function draftOf(v: JsonMap): Draft {
  return {
    title: str(v.title), main: str(v.main), extra: str(v.extra), aliases: list(v.aliases), tags: list(v.tags),
    relationships: Array.isArray(v.relationships) ? (v.relationships as Relationship[]) : [], blobs: blobsOf(v),
  };
}

/** What `draft` saves as: only the props that have something in them. */
export function noteValue(id: string | undefined, d: Draft): JsonMap {
  const aliases = split(d.aliases);
  const tags = split(d.tags);
  return {
    ...(id ? { id } : {}),
    gestalt: 'note@1',
    ...(d.title.trim() ? { title: d.title.trim() } : {}),
    ...(d.main.trim() ? { main: d.main } : {}),
    ...(d.extra.trim() ? { extra: d.extra } : {}),
    ...(aliases.length ? { aliases } : {}),
    ...(tags.length ? { tags } : {}),
    ...(d.relationships.length ? { relationships: d.relationships } : {}),
    ...(d.blobs.length ? { blobs: d.blobs } : {}),
  };
}

function NoteSearch({ onPick }: { onPick: (id: string) => void }) {
  const [text, setText] = useState('');
  const { items } = useQuery(text.trim() ? { gestalt: 'note@1', text, limit: 8, fields: ['title', 'main'] } : null);
  return (
    <div className="flex flex-col gap-1">
      <input className="input input-sm w-full" placeholder="Find a note to link…" value={text} onChange={(e) => setText(e.target.value)} />
      {items.map((n) => (
        <button key={n.id} type="button" className="btn btn-ghost btn-xs justify-start truncate font-normal" onClick={() => { onPick(n.id); setText(''); }}>
          {str(n.value.title) || str(n.value.main).slice(0, 60) || n.id}
        </button>
      ))}
    </div>
  );
}

/** Edits every prop of a `note`; `note` absent makes a new one. */
export function NoteEditor({ note, onDone }: { note?: Item; onDone: (saved?: Item) => void }) {
  const write = useWrite();
  const [draft, setDraft] = useState(() => draftOf(note?.value ?? {}));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try { onDone(await write.put(noteValue(note?.id, draft))); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const attach = async (files: FileList | null) => {
    setError(undefined);
    for (const f of Array.from(files ?? [])) {
      try {
        const b = await storeFile(write, f);
        setDraft((d) => (d.blobs.some((x) => x.file === b.file) ? d : { ...d, blobs: [...d.blobs, b] }));
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    }
  };
  return (
    <div className="flex flex-col gap-3 p-3">
      <input className="input w-full" placeholder="Title" value={draft.title} onChange={(e) => set({ title: e.target.value })} />
      <MarkdownEditor value={draft.main} onChange={(main: string) => set({ main })} placeholder="Main" />
      <MarkdownEditor value={draft.extra} onChange={(extra: string) => set({ extra })} placeholder="Extra" />
      <input className="input input-sm w-full" placeholder="Aliases, comma separated" value={draft.aliases} onChange={(e) => set({ aliases: e.target.value })} />
      <input className="input input-sm w-full" placeholder="Tags, comma separated" value={draft.tags} onChange={(e) => set({ tags: e.target.value })} />

      <section className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Relationships</h3>
        {draft.relationships.map((r, i) => (
          <div key={`${r.to}:${i}`} className="flex items-center gap-2">
            <input className="input input-xs w-32" aria-label="Label" value={r.label} onChange={(e) => set({ relationships: draft.relationships.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            <code className="min-w-0 flex-1 truncate text-xs">{r.to}</code>
            <button type="button" className="btn btn-ghost btn-xs btn-square" title="Remove" onClick={() => set({ relationships: draft.relationships.filter((_, j) => j !== i) })}><Trash2 className="size-3" /></button>
          </div>
        ))}
        <NoteSearch onPick={(to) => set({ relationships: [...draft.relationships, { to, label: 'related' }] })} />
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Files</h3>
        {draft.blobs.map((b, i) => (
          <div key={b.file} className="flex items-center gap-2">
            <input className="input input-xs w-32" aria-label="Label" value={b.label} onChange={(e) => set({ blobs: draft.blobs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            <code className="min-w-0 flex-1 truncate text-xs">{b.file}</code>
            <button type="button" className="btn btn-ghost btn-xs btn-square" title="Remove" onClick={() => set({ blobs: draft.blobs.filter((_, j) => j !== i) })}><Trash2 className="size-3" /></button>
          </div>
        ))}
        <input type="file" multiple className="file-input file-input-sm w-full" onChange={(e) => { void attach(e.target.files); e.target.value = ''; }} />
      </section>

      {error && <div role="alert" className="alert alert-error text-sm whitespace-pre-wrap">{error}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onDone()}>Cancel</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void save()}>Save</button>
      </div>
    </div>
  );
}
