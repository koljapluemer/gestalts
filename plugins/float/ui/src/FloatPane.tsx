import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { EyeOff } from 'lucide-react';
import { definePane, definePerspective, useHost, type Query } from '@gestalts/sdk';
import { Modal, Note, buildIndex, search, type TagToggle } from '@gestalts/kit';
import { BATCH, HIDE_TAG, POOL, SPAWN_MS, draw, flight } from './float';
import './float.css';

/** tags the note `no-float`, to leave it out of Float; toggled again, the tag comes off */
const HIDE: TagToggle[] = [{ tag: HIDE_TAG, icon: EyeOff, title: 'hide from float', activeTitle: 'hidden from float (click: back in it)' }];

type Card = { id: number; key: string; top: string; duration: number };

let nextId = 0;

function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
}

/**
 * Random notes of yours (see `POOL`) drifting across the stage, one every few seconds, drawn `BATCH` at a time; the
 * filter below keeps those it finds (`/` focuses it). A card stops under the pointer; its edit tool opens the note in a
 * modal, which holds the stage still. A card's hide toggle tags the note `no-float`; it drifts on, and isn't drawn again.
 */
const Float = definePerspective<{ pool: Query }>({
  id: 'float',
  title: 'Float',
  data: { pool: POOL },
  Component: ({ data, repo }) => {
    const onOpen = useHost().openNote;
    const [q, setQ] = useState('');
    const query = useDeferredValue(q.trim());
    const filter = useRef<HTMLInputElement>(null);
    const [cards, setCards] = useState<Card[]>([]);
    const [editing, setEditing] = useState<Card | null>(null);

    const index = useMemo(() => buildIndex(data.pool), [data.pool]);
    const keys = useMemo(() => (query ? search(index, query).notes : data.pool).map((n) => n.key), [index, query, data.pool]);

    // the drawn keys not yet sent off; another filter starts a new draw
    const pending = useRef<string[]>([]);
    const latest = useRef(keys);
    useEffect(() => { latest.current = keys; });
    useEffect(() => { pending.current = []; }, [query]);

    useEffect(() => {
      if (editing) return;
      const spawn = () => {
        const inPool = new Set(latest.current);
        if (!pending.current.some((k) => inPool.has(k))) pending.current = draw(latest.current, BATCH);
        let key: string | undefined;
        // hidden or deleted since the draw: skipped
        while ((key = pending.current.shift()) !== undefined && !inPool.has(key));
        if (key === undefined) return;
        setCards((cs) => [...cs, { id: nextId++, key: key as string, ...flight(Math.random(), Math.random()) }]);
      };
      const first = setTimeout(spawn, 200);
      const timer = setInterval(spawn, SPAWN_MS);
      return () => { clearTimeout(first); clearInterval(timer); };
    }, [editing]);

    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== '/' || typing(e) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
        e.preventDefault();
        filter.current?.focus();
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, []);

    const drop = (id: number) => setCards((cs) => cs.filter((c) => c.id !== id));
    // the card is gone, and the stage moves on
    const close = () => {
      if (editing) drop(editing.id);
      setEditing(null);
    };
    // deleted notes drop out at once
    const shown = cards.filter((c) => repo.get(c.key));

    return (
      <div className="flex h-full min-h-[24rem] flex-col p-3">
        <div className={`gestalts-float-stage relative min-h-0 flex-1 overflow-hidden ${editing ? 'paused' : ''}`}>
          {!keys.length && (
            <p className="my-6 text-base-content/50">{data.pool.length ? 'No notes match the filter.' : 'No notes to float.'}</p>
          )}
          {shown.map((c) => (
            <div key={c.id} className="gestalts-float-card card w-64 bg-base-200 shadow-lg"
                 style={{ top: c.top, animationDuration: `${c.duration}s` }} onAnimationEnd={() => drop(c.id)}>
              <Note noteKey={c.key} render="simple" tagToggles={HIDE} onOpen={onOpen} onEdit={() => setEditing(c)}
                    onDeleted={() => drop(c.id)} className="card-body max-h-64 overflow-hidden p-3" />
            </div>
          ))}
        </div>
        <input ref={filter} type="search" className="input mt-3 w-full" placeholder="Filter (/)" value={q}
               onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') e.currentTarget.blur(); }} />
        {editing && (
          <Modal onClose={close}>
            <Note key={editing.id} noteKey={editing.key} tagToggles={HIDE} onOpen={onOpen} onDeleted={close} className="p-4" />
          </Modal>
        )}
      </div>
    );
  },
});

export const FloatPane = definePane({ title: 'Float', Component: () => <Float /> });
