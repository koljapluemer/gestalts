import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { MarkdownEditor, storeFile } from '@gestalts/kit';
import { useBlobUrl, useDoc, useQuery, useViewState, useWrite, type Item, type JsonMap } from '@gestalts/view';

type Blob = { file: string; label: string };
type Draft = { front: string; context: string; back: string; extra: string; sources: unknown[]; tags: string; aliases: string; blobs: Blob[]; concepts: Record<string, number> };

const PAGE = 40;
const SLOTS: { label: string; title: string; accept: string }[] = [
  { label: 'front', title: 'Front image', accept: 'image/*' },
  { label: 'back', title: 'Back image', accept: 'image/*' },
  { label: 'audio', title: 'Audio', accept: 'audio/*' },
];

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : '');
const split = (s: string) => [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))];
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function draftOf(v: JsonMap): Draft {
  return {
    front: str(v.front), context: str(v.context), back: str(v.back), extra: str(v.extra), sources: Array.isArray(v.sources) ? v.sources : [], tags: list(v.tags), aliases: list(v.aliases),
    blobs: (v.blobs ?? []) as Blob[], concepts: (v.concepts ?? {}) as Record<string, number>,
  };
}

/** What `d` saves as: only the props that have something in them. */
function cardValue(id: string | undefined, d: Draft): JsonMap {
  const tags = split(d.tags);
  const aliases = split(d.aliases);
  return {
    ...(id ? { id } : {}),
    gestalt: 'flashcard@1',
    front: d.front,
    ...(d.context.trim() ? { context: d.context } : {}),
    ...(d.back.trim() ? { back: d.back } : {}),
    ...(d.extra.trim() ? { extra: d.extra } : {}),
    ...(d.blobs.length ? { blobs: d.blobs } : {}),
    ...(tags.length ? { tags } : {}),
    ...(aliases.length ? { aliases } : {}),
    ...(Object.keys(d.concepts).length ? { concepts: d.concepts } : {}),
    // kept as they are: credits aren't edited here
    ...(d.sources.length ? { sources: d.sources as JsonMap[] } : {}),
  };
}

function useDebounced(value: string, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

function List({ selected, onSelect, onNew }: { selected: string | null; onSelect: (id: string) => void; onNew: () => void }) {
  const [search, setSearch] = useViewState<string>('search', '');
  const text = useDebounced(search, 150);
  const { items, loading, hasMore, more } = useQuery({ gestalt: 'flashcard@1', ...(text.trim() ? { text } : {}), limit: PAGE, fields: ['front'] });
  const end = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!hasMore || !end.current) return;
    const seen = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) more(); });
    seen.observe(end.current);
    return () => seen.disconnect();
  }, [hasMore, more, items.length]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex gap-2 border-b border-base-300 p-2">
        <input className="input input-sm min-w-0 flex-1" type="search" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button type="button" className="btn btn-sm btn-primary btn-square" title="New flashcard" onClick={onNew}><Plus className="size-4" /></button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {items.map((c) => (
          <li key={c.id}>
            <button type="button" className={`w-full truncate px-3 py-3 text-left hover:bg-base-200 ${c.id === selected ? 'bg-base-300' : ''}`} onClick={() => onSelect(c.id)}>{str(c.value.front).trim().split('\n')[0] || '(empty)'}</button>
          </li>
        ))}
        {hasMore && <li ref={end} className="flex justify-center p-3"><span className="loading loading-spinner loading-sm" /></li>}
        {!loading && !items.length && <li className="p-6 text-center text-base-content/60">{text.trim() ? 'Nothing found.' : 'No flashcards yet.'}</li>}
      </ul>
    </div>
  );
}

function BlobSlot({ title, accept, file, onFile, onClear }: { title: string; accept: string; file?: string; onFile: (f: File) => void; onClear: () => void }) {
  const url = useBlobUrl(file);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-semibold">{title}</span>
      {url && (accept === 'audio/*' ? <audio controls src={url} className="w-full" /> : <img src={url} alt="" className="rounded-box max-h-32 self-start object-contain" />)}
      <div className="flex items-center gap-2">
        <input type="file" accept={accept} aria-label={title} className="file-input file-input-sm min-w-0 flex-1" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
        {file && <button type="button" className="btn btn-ghost btn-sm btn-square" title={`Remove ${title.toLowerCase()}`} onClick={onClear}><Trash2 className="size-4" /></button>}
      </div>
    </div>
  );
}

function Concepts({ value, onChange, onError }: { value: Record<string, number>; onChange: (v: Record<string, number>) => void; onError: (e: unknown) => void }) {
  const write = useWrite();
  const [search, setSearch] = useState('');
  const text = useDebounced(search, 150).trim();
  const ids = Object.keys(value);
  const attached = useQuery(ids.length ? { gestalt: 'concept@2', ids, fields: ['name'], limit: ids.length } : null).items;
  const found = useQuery(text ? { gestalt: 'concept@2', text, fields: ['name'], limit: 8 } : null).items;
  const add = (id: string) => { onChange({ ...value, [id]: value[id] ?? 1 }); setSearch(''); };
  const create = () => write.put({ gestalt: 'concept@2', name: text }).then((c) => add(c.id), onError);
  const strength = (raw: string) => Math.min(1, Math.max(0, Number(raw) || 0));
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold">Concepts</h3>
      {ids.map((id) => (
        <div key={id} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm">{str(attached.find((c) => c.id === id)?.value.name) || id}</span>
          <input className="input input-xs w-20" type="number" min={0} max={1} step={0.05} aria-label="Strength, 0 to 1" value={value[id]} onChange={(e) => onChange({ ...value, [id]: strength(e.target.value) })} />
          <button type="button" className="btn btn-ghost btn-xs btn-square" title="Remove" onClick={() => { const { [id]: _gone, ...rest } = value; onChange(rest); }}><Trash2 className="size-3" /></button>
        </div>
      ))}
      <input className="input input-sm w-full" placeholder="Find or create a concept…" value={search} onChange={(e) => setSearch(e.target.value)} />
      {text && found.map((c) => <button key={c.id} type="button" className="btn btn-ghost btn-xs justify-start truncate font-normal" onClick={() => add(c.id)}>{str(c.value.name)}</button>)}
      {text && !found.some((c) => c.value.name === text) && <button type="button" className="btn btn-ghost btn-xs justify-start truncate font-normal" onClick={() => void create()}>Create “{text}”</button>}
    </section>
  );
}

/** Every prop of a flashcard on one screen; `card` absent makes a new one. */
function Editor({ card, onBack, onSaved, onDeleted }: { card?: Item; onBack: () => void; onSaved: (saved: Item) => void; onDeleted: () => void }) {
  const write = useWrite();
  const [draft, setDraft] = useState(() => draftOf(card?.value ?? {}));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const states = useQuery(card ? { gestalt: 'fsrs-data@1', refs: { to: card.id, field: 'target' }, fields: [], limit: 100 } : null).items;
  const set = (patch: Partial<Draft>) => { setSaved(false); setDraft((d) => ({ ...d, ...patch })); };
  const fail = (e: unknown) => setError(message(e));

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onSaved(await write.put(cardValue(card?.id, draft)));
      setSaved(true);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!card || !confirm('Delete this flashcard and its review progress?')) return;
    try {
      await Promise.all(states.map((s) => write.remove(s.id)));
      await write.remove(card.id);
      onDeleted();
    } catch (e) { fail(e); }
  };
  const attach = async (label: string, f: File) => {
    setError(undefined);
    try {
      const { file } = await storeFile(write, f);
      setSaved(false);
      setDraft((d) => ({ ...d, blobs: [...d.blobs.filter((b) => b.label !== label), { file, label }] }));
    } catch (e) { fail(e); }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-base-300 p-2">
        <button type="button" className="btn btn-sm btn-ghost md:hidden" title="Back to the list" onClick={onBack}><ArrowLeft className="size-4" /></button>
        <span className="flex-1" />
        {saved && <span className="text-sm text-base-content/60">Saved</span>}
        {card && <button type="button" className="btn btn-sm btn-ghost" onClick={() => void remove()}><Trash2 className="size-4" /> Delete</button>}
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || !draft.front.trim()} onClick={() => void save()}>Save</button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {error && <div role="alert" className="alert alert-error text-sm whitespace-pre-wrap">{error}</div>}
        <MarkdownEditor value={draft.front} onChange={(front: string) => set({ front })} placeholder="Front" />
        <MarkdownEditor value={draft.context} onChange={(context: string) => set({ context })} placeholder="Context, small print with the front" minHeight="2rem" />
        <MarkdownEditor value={draft.back} onChange={(back: string) => set({ back })} placeholder="Back" />
        <MarkdownEditor value={draft.extra} onChange={(extra: string) => set({ extra })} placeholder="Extra, shown after the reveal" minHeight="3rem" />
        <div className="grid gap-3 md:grid-cols-3">
          {SLOTS.map((s) => (
            <BlobSlot key={s.label} title={s.title} accept={s.accept} file={draft.blobs.find((b) => b.label === s.label)?.file}
                      onFile={(f) => void attach(s.label, f)} onClear={() => set({ blobs: draft.blobs.filter((b) => b.label !== s.label) })} />
          ))}
        </div>
        <input className="input input-sm w-full" placeholder="Tags, comma separated" value={draft.tags} onChange={(e) => set({ tags: e.target.value })} />
        <input className="input input-sm w-full" placeholder="Aliases, comma separated" value={draft.aliases} onChange={(e) => set({ aliases: e.target.value })} />
        <Concepts value={draft.concepts} onChange={(concepts) => set({ concepts })} onError={fail} />
      </div>
    </div>
  );
}

function Existing({ id, onBack, onDeleted }: { id: string; onBack: () => void; onDeleted: () => void }) {
  const card = useDoc('flashcard@1', id);
  return card ? <Editor card={card} onBack={onBack} onSaved={() => {}} onDeleted={onDeleted} /> : null;
}

/** On a phone, the list or the card; on anything wider, side by side. */
export default function FlashcardManager() {
  const [selected, setSelected] = useViewState<string | null>('selected', null);
  const [creating, setCreating] = useState(false);
  const showEditor = selected !== null || creating;
  const close = () => { setCreating(false); setSelected(null); };
  return (
    <div className="flex h-full bg-base-100">
      <div className={`h-full w-full border-base-300 md:w-80 md:shrink-0 md:border-r ${showEditor ? 'hidden md:block' : ''}`}>
        <List selected={selected} onSelect={(id) => { setCreating(false); setSelected(id); }} onNew={() => { setSelected(null); setCreating(true); }} />
      </div>
      <div className={`h-full min-w-0 flex-1 ${showEditor ? '' : 'hidden md:block'}`}>
        {creating && <Editor onBack={close} onSaved={(s) => { setCreating(false); setSelected(s.id); }} onDeleted={close} />}
        {!creating && selected && <Existing key={selected} id={selected} onBack={close} onDeleted={close} />}
      </div>
    </div>
  );
}
