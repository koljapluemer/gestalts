import { useState } from 'react';
import { BookPlus, Trash2 } from 'lucide-react';
import { useQuery, useWrite, type Item, type JsonMap } from '@gestalts/view';
import { MarkdownEditor, useDebounced } from '../primitives';
import { AddSource, SOURCE_LABEL, byline, sourceTitle, storeFile } from '../widgets';
import { blobsOf, type BlobRef } from './NoteCard';

const NOTE = 'note@1';
const SOURCE = 'source@1';
const CONCEPT = 'concept@2';
/** a relationship's label when nothing more specific is said */
export const RELATED = 'related';

/** `label` empty while it's being edited: it's saved as `related` */
type Relationship = { to: string; label: string };
type Draft = { title: string; main: string; extra: string; aliases: string; tags: string; relationships: Relationship[]; blobs: BlobRef[] };

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(', ') : '');
const split = (s: string) => [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))];

function draftOf(v: JsonMap): Draft {
  return {
    title: str(v.title), main: str(v.main), extra: str(v.extra), aliases: list(v.aliases), tags: list(v.tags),
    // `related` shows as the placeholder it is
    relationships: (Array.isArray(v.relationships) ? (v.relationships as Relationship[]) : []).map((r) => (r.label === RELATED ? { ...r, label: '' } : r)),
    blobs: blobsOf(v),
  };
}

/** What `draft` saves as: only the props that have something in them. */
export function noteValue(id: string | undefined, d: Draft): JsonMap {
  const aliases = split(d.aliases);
  const tags = split(d.tags);
  return {
    ...(id ? { id } : {}),
    gestalt: NOTE,
    ...(d.title.trim() ? { title: d.title.trim() } : {}),
    ...(d.main.trim() ? { main: d.main } : {}),
    ...(d.extra.trim() ? { extra: d.extra } : {}),
    ...(aliases.length ? { aliases } : {}),
    ...(tags.length ? { tags } : {}),
    ...(d.relationships.length ? { relationships: d.relationships.map((r) => ({ to: r.to, label: r.label.trim() || RELATED })) } : {}),
    ...(d.blobs.length ? { blobs: d.blobs } : {}),
  };
}

type Target = { kind: 'note' | 'source' | 'concept'; name: string; detail?: string };

const noteName = (v: JsonMap) => str(v.title) || str(v.main).trim().split('\n')[0].slice(0, 80) || '(empty)';
const targetOf = (i: Item): Target => (
  i.gestalt === SOURCE ? { kind: 'source', name: sourceTitle(i.value), detail: byline(i.value) }
    : i.gestalt === CONCEPT ? { kind: 'concept', name: str(i.value.name) }
      : { kind: 'note', name: noteName(i.value) }
);

/** What `ids` point at, readably, by id; undefined while still asked; missing ones point at nothing (deleted). */
function useTargets(ids: string[]): Map<string, Target> | undefined {
  const unique = [...new Set(ids)];
  const q = (gestalt: string, fields: string[]) => (unique.length ? { gestalt, ids: unique, fields, limit: unique.length } : null);
  const notes = useQuery(q(NOTE, ['title', 'main']));
  const sources = useQuery(q(SOURCE, ['title', 'key', 'author', 'editor', 'date']));
  const concepts = useQuery(q(CONCEPT, ['name']));
  if (unique.length && (notes.loading || sources.loading || concepts.loading)) return undefined;
  return new Map([...notes.items, ...sources.items, ...concepts.items].map((i) => [i.id, targetOf(i)]));
}

/** Finding a note or a concept to relate to; `exclude` aren't offered. */
function LinkSearch({ exclude, onPick }: { exclude: Set<string>; onPick: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const text = useDebounced(search, 150).trim();
  const notes = useQuery(text ? { gestalt: NOTE, text, limit: 6, fields: ['title', 'main'] } : null);
  const concepts = useQuery(text ? { gestalt: CONCEPT, text, limit: 6, fields: ['name'] } : null);
  const found = [...concepts.items, ...notes.items].filter((i) => !exclude.has(i.id));
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <input className="input input-sm w-full" type="search" placeholder="Link a note or concept…" value={search} onChange={(e) => setSearch(e.target.value)} />
      {found.map((i) => {
        const t = targetOf(i);
        return (
          <button key={i.id} type="button" className="btn btn-ghost btn-sm justify-start gap-2 font-normal" onClick={() => { onPick(i.id); setSearch(''); }}>
            <span className="badge badge-ghost badge-sm">{t.kind}</span>
            <span className="min-w-0 truncate">{t.name}</span>
          </button>
        );
      })}
      {text && !notes.loading && !concepts.loading && !found.length && <p className="px-2 text-sm text-base-content/60">Nothing found.</p>}
    </div>
  );
}

/** A note's relationships: each to something named, with a label (`related` when left empty). */
function Relationships({ self, value, onChange }: { self?: string; value: Relationship[]; onChange: (r: Relationship[]) => void }) {
  const targets = useTargets(value.map((r) => r.to));
  const [adding, setAdding] = useState(false);
  const linked = new Set(value.map((r) => r.to));
  const add = (ids: string[], label: string) => {
    const fresh = [...new Set(ids)].filter((id) => !linked.has(id));
    if (fresh.length) onChange([...value, ...fresh.map((to) => ({ to, label }))]);
  };
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">Relationships</h3>
      {value.map((r, i) => {
        const t = targets?.get(r.to);
        return (
          <div key={`${r.to}:${i}`} className="flex items-center gap-2">
            <input className="input input-sm w-36 shrink-0" aria-label="How it relates" placeholder={RELATED} value={r.label}
                   onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            <span className="min-w-0 flex-1">
              {t ? <>
                <span className="block truncate text-sm"><span className="badge badge-ghost badge-sm mr-1">{t.kind}</span>{t.name}</span>
                {t.detail && <span className="block truncate text-xs text-base-content/60">{t.detail}</span>}
              </> : <span className="block truncate text-xs text-base-content/50">{targets ? '(gone) ' : ''}<code>{r.to}</code></span>}
            </span>
            <button type="button" className="btn btn-ghost btn-xs btn-square" title="Remove the relationship" onClick={() => onChange(value.filter((_, j) => j !== i))}><Trash2 className="size-3" /></button>
          </div>
        );
      })}
      <div className="flex items-start gap-2">
        <LinkSearch exclude={new Set([...linked, ...(self ? [self] : [])])} onPick={(id) => add([id], '')} />
        <button type="button" className="btn btn-ghost btn-sm" title="Add a source" onClick={() => setAdding(true)}><BookPlus className="size-4" /> Source</button>
      </div>
      {adding && <AddSource attached={linked} onAdd={(ids) => { setAdding(false); add(ids, SOURCE_LABEL); }} onClose={() => setAdding(false)} />}
    </section>
  );
}

/**
 * Edits every prop of a `note`; `note` absent makes a new one. It reads `note@1`, `source@1` and `concept@2` (what a
 * note relates to) and writes `note@1` and `source@1` (sources pasted in as BibTeX).
 */
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

      <Relationships self={note?.id} value={draft.relationships} onChange={(relationships) => set({ relationships })} />

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
