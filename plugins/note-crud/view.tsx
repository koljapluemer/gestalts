import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import { NoteCard, NoteEditor } from '@gestalts/kit';
import { useDoc, useQuery, useViewState, useWrite, type Item } from '@gestalts/view';

const LIST_FIELDS = ['title', 'main'];
const PAGE = 40;

function firstLine(n: Item): string {
  const { title, main } = n.value;
  if (typeof title === 'string' && title) return title;
  if (typeof main === 'string' && main.trim()) return main.trim().split('\n')[0];
  return '(empty)';
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
  const { items, loading, hasMore, more } = useQuery({ gestalt: 'note@1', ...(text.trim() ? { text } : {}), limit: PAGE, fields: LIST_FIELDS });
  const end = useRef<HTMLLIElement>(null);
  // loads the next page as its end comes into view
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
        <button type="button" className="btn btn-sm btn-primary btn-square" title="New note" onClick={onNew}><Plus className="size-4" /></button>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {items.map((n) => (
          <li key={n.id}>
            <button type="button" className={`w-full truncate px-3 py-3 text-left hover:bg-base-200 ${n.id === selected ? 'bg-base-300' : ''}`} onClick={() => onSelect(n.id)}>{firstLine(n)}</button>
          </li>
        ))}
        {hasMore && <li ref={end} className="flex justify-center p-3"><span className="loading loading-spinner loading-sm" /></li>}
        {!loading && !items.length && <li className="p-6 text-center text-base-content/60">{text.trim() ? 'Nothing found.' : 'No notes yet.'}</li>}
      </ul>
    </div>
  );
}

function Detail({ id, onBack, onDeleted }: { id: string; onBack: () => void; onDeleted: () => void }) {
  const note = useDoc('note@1', id);
  const write = useWrite();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();
  if (!note) return null;
  if (editing) return <div className="h-full overflow-y-auto"><NoteEditor key={note.id} note={note} onDone={() => setEditing(false)} /></div>;
  const remove = () => {
    if (confirm('Delete this note?')) write.remove(note.id).then(onDeleted, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex gap-1 border-b border-base-300 p-2">
        <button type="button" className="btn btn-sm btn-ghost md:hidden" onClick={onBack}><ArrowLeft className="size-4" /></button>
        <span className="flex-1" />
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(true)}><Pencil className="size-4" /> Edit</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={remove}><Trash2 className="size-4" /> Delete</button>
      </div>
      {error && <div role="alert" className="alert alert-error m-2 text-sm">{error}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto p-4"><NoteCard value={note.value} /></div>
    </div>
  );
}

/** On a phone, the list or the note; on anything wider, side by side. */
export default function NoteCrud() {
  const [selected, setSelected] = useViewState<string | null>('selected', null);
  const [creating, setCreating] = useState(false);
  const showDetail = selected !== null || creating;
  return (
    <div className="flex h-full bg-base-100">
      <div className={`h-full w-full border-base-300 md:w-80 md:shrink-0 md:border-r ${showDetail ? 'hidden md:block' : ''}`}>
        <List selected={selected} onSelect={(id) => { setCreating(false); setSelected(id); }} onNew={() => { setSelected(null); setCreating(true); }} />
      </div>
      <div className={`h-full min-w-0 flex-1 ${showDetail ? '' : 'hidden md:block'}`}>
        {creating && <div className="h-full overflow-y-auto"><NoteEditor onDone={(saved) => { setCreating(false); if (saved) setSelected(saved.id); }} /></div>}
        {!creating && selected && <Detail key={selected} id={selected} onBack={() => setSelected(null)} onDeleted={() => setSelected(null)} />}
      </div>
    </div>
  );
}
