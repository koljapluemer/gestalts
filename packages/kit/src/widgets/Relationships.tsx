import { useState } from 'react';
import { Link2, Link2Off, Plus } from 'lucide-react';
import { asMap, type IndexedNote, type Json, type Repo } from '@gestalts/sdk';
import { NoteLine } from '../components';
import { refsOf, useBacklinks } from './backlinks';
import { NotePicker } from './NotePicker';
import { addRelation, relabelRelation, removeRelation, rowsOf, type Row } from './relationModel';

type Props = {
  note: IndexedNote;
  repo: Repo;
  /** a related note was clicked; without it rows aren't clickable */
  onOpen?: (key: string) => void;
};

type JsonMap = { [key: string]: Json };

const ARROW = { out: '→', in: '←' } as const;
const INLINE_ARROW = { out: '⇢', in: '⇠' } as const;

/**
 * A note's relationships and backlinks together. Explicit ones can be detached and relabelled, and new ones added in
 * either direction; each change is written at once, to whichever note holds the relationship. Inline references
 * (`⇢`, `⇠`) are read-only here: they're edited in the text.
 */
export function Relationships({ note, repo, onOpen }: Props) {
  const backlinks = useBacklinks(note.key);
  const rows = rowsOf(note, backlinks, (id) => repo.keyOf(id), refsOf);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Changes the value of the note `key` holding a relationship. */
  const write = async (key: string, change: (v: JsonMap) => JsonMap) => {
    setError(null);
    try {
      const n = repo.get(key);
      const v = asMap(n?.value);
      if (!n || !v) throw new Error(n ? `${key} does not parse; fix its YAML first.` : `No note ${key}`);
      const next = change(v);
      if (next !== v) await repo.putValue(key, next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  // which note holds a row's relationship, and how it names the other end
  const holder = (r: Row) => (r.dir === 'out' ? { key: note.key, target: r.other } : { key: r.other, target: r.via ?? note.id });
  const detach = (r: Row) => { const h = holder(r); void write(h.key, (v) => removeRelation(v, h.target, r.label)); };
  const relabel = (r: Row, next: string) => { const h = holder(r); void write(h.key, (v) => relabelRelation(v, h.target, r.label, next)); };
  const add = (dir: 'out' | 'in', label: string, otherKey: string) => {
    const other = repo.get(otherKey);
    if (!other) return;
    void (dir === 'out' ? write(note.key, (v) => addRelation(v, other.id, label)) : write(otherKey, (v) => addRelation(v, note.id, label)));
  };

  return (
    <section className="card card-border bg-base-100">
      <div className="card-body gap-2 p-3">
        <header className="flex items-center gap-2">
          <Link2 className="size-4" />
          <h3 className="flex-1 font-semibold">Relationships {rows.length > 0 && <span className="font-normal text-base-content/50">({rows.length})</span>}</h3>
          {!adding && (
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => setAdding(true)}><Plus className="size-3.5" /> Relate</button>
          )}
        </header>
        {rows.length > 0 && (
          <ul className="flex flex-col gap-1">
            {rows.map((r, i) => (
              <RelationRow key={`${r.dir} ${r.inline} ${r.other} ${r.label ?? ''} ${i}`} row={r} repo={repo} onOpen={onOpen}
                           onDetach={r.inline ? undefined : () => detach(r)} onRelabel={r.inline ? undefined : (l) => relabel(r, l)} />
            ))}
          </ul>
        )}
        {adding && <Adder self={note.key} onAdd={(dir, label, key) => { add(dir, label, key); setAdding(false); }} onCancel={() => setAdding(false)} />}
        {error && <p role="alert" className="text-sm text-error">{error}</p>}
      </div>
    </section>
  );
}

function RelationRow({ row, repo, onOpen, onDetach, onRelabel }: {
  row: Row;
  repo: Repo;
  onOpen?: (key: string) => void;
  onDetach?: () => void;
  onRelabel?: (label: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const other = row.otherKey ? repo.get(row.otherKey) : undefined;
  const arrow = (row.inline ? INLINE_ARROW : ARROW)[row.dir];
  const commit = () => { if (editing !== null && editing.trim() !== (row.label ?? '')) onRelabel?.(editing); setEditing(null); };
  return (
    <li className="rounded-box px-1 py-0.5 hover:bg-base-200">
      <div className="flex items-center gap-1 text-xs text-base-content/60">
        {onDetach && (
          <button type="button" className="btn btn-ghost btn-xs btn-square" title="Detach" onClick={onDetach}><Link2Off className="size-3.5" /></button>
        )}
        <span title={row.inline ? 'a reference in the text' : row.dir === 'out' ? 'from this note' : 'to this note'}>{arrow}</span>
        {editing !== null
          ? (
            <input
              className="input input-xs w-40"
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- opened on purpose, to type into
              autoFocus
              placeholder="label"
              value={editing}
              onChange={(e) => setEditing(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
                else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); }
              }}
            />
          )
          : onRelabel
            ? <button type="button" className="cursor-text tracking-wide uppercase hover:underline" title="Change the label" onClick={() => setEditing(row.label ?? '')}>{row.label ?? 'no label'}</button>
            : row.label && <span className="tracking-wide uppercase">{row.label}</span>}
      </div>
      <div className="pl-1 text-sm">
        {other
          ? onOpen
            ? <button type="button" className="w-full cursor-pointer text-left hover:underline" onClick={() => onOpen(other.key)}><NoteLine note={other} /></button>
            : <NoteLine note={other} />
          : <span className="text-base-content/50 line-through" title="no such note">{row.other}</span>}
      </div>
    </li>
  );
}

function Adder({ self, onAdd, onCancel }: { self: string; onAdd: (dir: 'out' | 'in', label: string, key: string) => void; onCancel: () => void }) {
  const [dir, setDir] = useState<'out' | 'in'>('out');
  const [label, setLabel] = useState('');
  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- Esc closes the adder
    <div className="flex flex-col gap-2 rounded-box border border-base-300 p-2" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}>
      <div className="flex items-center gap-2">
        <div className="join">
          <button type="button" className={`btn btn-xs join-item ${dir === 'out' ? 'btn-active' : ''}`} title="from this note to the one picked" onClick={() => setDir('out')}>→ to</button>
          <button type="button" className={`btn btn-xs join-item ${dir === 'in' ? 'btn-active' : ''}`} title="from the one picked to this note" onClick={() => setDir('in')}>← from</button>
        </div>
        <input className="input input-xs flex-1" placeholder="label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button type="button" className="btn btn-ghost btn-xs" onClick={onCancel}>Cancel</button>
      </div>
      <NotePicker autofocus limit={6} placeholder="Pick a note" onPick={(key) => { if (key !== self) onAdd(dir, label, key); }} />
    </div>
  );
}
