import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import { ConfirmDialog, NoteCard, NoteEditor, useDebounced } from '@gestalts/kit';
import { useDoc, useParams, useQuery, useViewState, useWrite, type Item } from '@gestalts/view';

const LIST_FIELDS = ['title', 'main'];
const PAGE = 40;

function firstLine(n: Item): string {
  const { title, main } = n.value;
  if (typeof title === 'string' && title) return title;
  if (typeof main === 'string' && main.trim()) return main.trim().split('\n')[0];
  return '(empty)';
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

function Detail({ id, onBack, onEdit, onDeleted }: { id: string; onBack: () => void; onEdit: () => void; onDeleted: () => void }) {
  const note = useDoc('note@1', id);
  const write = useWrite();
  const [confirming, setConfirming] = useState(false);
  if (!note) return null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex gap-1 border-b border-base-300 p-2">
        <button type="button" className="btn btn-sm btn-ghost md:hidden" onClick={onBack}><ArrowLeft className="size-4" /></button>
        <span className="flex-1" />
        <button type="button" className="btn btn-sm btn-ghost" onClick={onEdit}><Pencil className="size-4" /> Edit</button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirming(true)}><Trash2 className="size-4" /> Delete</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4"><NoteCard value={note.value} /></div>
      {confirming && (
        <ConfirmDialog title="Delete this note?" onClose={() => setConfirming(false)} onConfirm={async () => { await write.remove(note.id); onDeleted(); }}>
          This cannot be undone.
        </ConfirmDialog>
      )}
    </div>
  );
}

/** The note `id` in the editor, once it's loaded. */
function Editing({ id, onDone }: { id: string; onDone: (saved?: Item) => void }) {
  const note = useDoc('note@1', id);
  if (!note) return null;
  return <div className="h-full overflow-y-auto"><NoteEditor note={note} onDone={onDone} /></div>;
}

/**
 * On a phone, the list or the note; on anything wider, side by side. Where it is is its params (so another view can
 * send it to a note): `note`, the note shown, and `edit=1` to edit it, or to write a new one without `note`.
 */
export default function NoteCrud() {
  const [params, setParams] = useParams();
  const selected = params.note ?? null;
  const editing = params.edit === '1';
  const show = (note: string | null, edit = false) => setParams({ ...(note ? { note } : {}), ...(edit ? { edit: '1' } : {}) });
  const done = (saved?: Item) => show(saved?.id ?? selected);
  return (
    <div className="flex h-full bg-base-100">
      <div className={`h-full w-full border-base-300 md:w-80 md:shrink-0 md:border-r ${selected || editing ? 'hidden md:block' : ''}`}>
        <List selected={selected} onSelect={(id) => show(id)} onNew={() => show(null, true)} />
      </div>
      <div className={`h-full min-w-0 flex-1 ${selected || editing ? '' : 'hidden md:block'}`}>
        {editing && !selected && <div className="h-full overflow-y-auto"><NoteEditor onDone={done} /></div>}
        {editing && selected && <Editing key={selected} id={selected} onDone={done} />}
        {!editing && selected && <Detail key={selected} id={selected} onBack={() => show(null)} onEdit={() => show(selected, true)} onDeleted={() => show(null)} />}
      </div>
    </div>
  );
}
