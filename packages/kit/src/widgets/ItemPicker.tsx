import { useId, useState, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { useQuery, useRead, useWrite, type Item, type Query } from '@gestalts/view';
import { useDebounced } from '../primitives';
import { NoteTitle } from './NoteTitle';

const NOTE = 'note@1';
const CONCEPT = 'concept@2';
const SHOWN = 8;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const fold = (s: string) => s.trim().toLowerCase();
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Create = {
  /** whether to offer it for what's typed and what was found */
  offer: (text: string, found: Item[]) => boolean;
  label: (text: string) => ReactNode;
  run: (text: string) => void | Promise<void>;
};

/**
 * A search box with what it finds below it, as a list to pick from: ↑/↓ move, Enter picks, Escape clears. `query` says
 * what to ask for what's typed, and should leave out in the core what mustn't be offered (`links.none`, a `limit`):
 * filtering after a limit can leave nothing to show. `exclude` is for a few more ids, dropped here. `create` offers
 * one more row, to make something new from the text.
 */
export function ItemPicker({ query, more, render, onPick, exclude, create, placeholder, autoFocus, size = 'sm' }: {
  query: (text: string) => Query;
  /** a second kind of thing to offer, after the first */
  more?: (text: string) => Query;
  render: (item: Item) => ReactNode;
  onPick: (item: Item) => void;
  exclude?: Set<string>;
  create?: Create;
  placeholder?: string;
  autoFocus?: boolean;
  size?: 'sm' | 'md';
}) {
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string>();
  const list = useId();
  const typed = search.trim();
  const text = useDebounced(search, 150).trim();
  const extra = exclude?.size ?? 0;
  // a few more than shown, as `exclude` may drop some
  const ask = (q: Query | null) => (q ? { ...q, limit: Math.min(500, (q.limit ?? SHOWN) + extra) } : null);
  const shown = (r: { items: Item[] }, q: Query | null) => r.items.filter((i) => !exclude?.has(i.id)).slice(0, q?.limit ?? SHOWN);
  const q1 = text ? query(text) : null;
  const q2 = text && more ? more(text) : null;
  const r1 = useQuery(ask(q1));
  const r2 = useQuery(ask(q2));
  const loading = r1.loading || r2.loading;
  const found = [...shown(r1, q1), ...shown(r2, q2)];
  // what was found for an older text isn't offered once the text has changed
  const current = text === typed ? found : [];
  const creating = !!create && !!typed && create.offer(typed, current);
  const count = current.length + (creating ? 1 : 0);
  const at = Math.min(active, Math.max(0, count - 1));
  const reset = () => { setSearch(''); setActive(0); };
  const choose = async (i: number) => {
    setError(undefined);
    if (i < current.length) { onPick(current[i]); reset(); return; }
    if (creating) {
      try { await create.run(typed); reset(); } catch (e) { setError(message(e)); }
    }
  };
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <input className={`input w-full ${size === 'sm' ? 'input-sm' : ''}`} type="search" placeholder={placeholder} value={search} autoFocus={autoFocus}
             role="combobox" aria-expanded={count > 0} aria-controls={list} aria-activedescendant={count ? `${list}-${at}` : undefined}
             onChange={(e) => { setSearch(e.target.value); setActive(0); }}
             onKeyDown={(e) => {
               if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(at + 1, count - 1)); }
               else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(at - 1, 0)); }
               else if (e.key === 'Enter') {
                 e.preventDefault();
                 // the text may be ahead of what was found: creating asks afresh anyway
                 if (count) void choose(at);
                 else if (create && typed) void choose(0);
               } else if (e.key === 'Escape' && search) { e.preventDefault(); reset(); }
             }} />
      {count > 0 && (
        <ul id={list} role="listbox" className="flex flex-col rounded-box border border-base-300 bg-base-100 p-1">
          {current.map((item, i) => (
            <li key={item.id} id={`${list}-${i}`} role="option" aria-selected={i === at}>
              <button type="button" className={`btn btn-ghost btn-sm h-auto w-full justify-start py-1 text-left font-normal ${i === at ? 'bg-base-200' : ''}`}
                      onMouseEnter={() => setActive(i)} onClick={() => void choose(i)}>
                {render(item)}
              </button>
            </li>
          ))}
          {creating && (
            <li id={`${list}-${current.length}`} role="option" aria-selected={at === current.length}>
              <button type="button" className={`btn btn-ghost btn-sm h-auto w-full justify-start py-1 text-left font-normal ${at === current.length ? 'bg-base-200' : ''}`}
                      onMouseEnter={() => setActive(current.length)} onClick={() => void choose(current.length)}>
                <Plus className="size-4 shrink-0" /> {create.label(typed)}
              </button>
            </li>
          )}
        </ul>
      )}
      {text && text === typed && !loading && !count && <p className="px-2 text-sm text-base-content/60">Nothing found.</p>}
      {error && <p role="alert" className="px-2 text-sm text-error">{error}</p>}
    </div>
  );
}

/** Notes found by their text. `unrelatedTo`: only those not related to that yml yet (asked of the core). */
export function NotePicker({ onPick, unrelatedTo, exclude, placeholder = 'Find a note…', autoFocus }: {
  onPick: (note: Item) => void; unrelatedTo?: string; exclude?: Set<string>; placeholder?: string; autoFocus?: boolean;
}) {
  return (
    <ItemPicker
      placeholder={placeholder} autoFocus={autoFocus} exclude={exclude} onPick={onPick}
      query={(text) => ({
        gestalt: NOTE, text, fields: ['title', 'main'], limit: SHOWN,
        ...(unrelatedTo ? { links: { none: [{ field: 'relationships', to: { ids: [unrelatedTo] } }] } } : {}),
      })}
      render={(n) => <NoteTitle value={n.value} />}
    />
  );
}

/** The concept named (or going by) `name` exactly, if there is one; asked afresh, as what's shown may lag the typing. */
export async function conceptNamed(read: ReturnType<typeof useRead>, name: string): Promise<Item | undefined> {
  const { items } = await read.page({ gestalt: CONCEPT, text: name, fields: ['name', 'aliases'], limit: 50 });
  return items.find((c) => fold(str(c.value.name)) === fold(name))
    ?? items.find((c) => strings(c.value.aliases).some((a) => fold(a) === fold(name)));
}

/**
 * Concepts found by their name or aliases, or a new one made from what's typed (unless one goes by that name already:
 * then it's that one). `onPick` gets the concept's id. `exclude`: ids not offered.
 */
export function ConceptPicker({ onPick, exclude, placeholder = 'Find or create a concept…', autoFocus, size }: {
  onPick: (id: string) => void; exclude?: Set<string>; placeholder?: string; autoFocus?: boolean; size?: 'sm' | 'md';
}) {
  const read = useRead();
  const write = useWrite();
  const same = (c: Item, name: string) => [str(c.value.name), ...strings(c.value.aliases)].some((n) => fold(n) === fold(name));
  return (
    <ItemPicker
      placeholder={placeholder} autoFocus={autoFocus} exclude={exclude} size={size} onPick={(c) => onPick(c.id)}
      query={(text) => ({ gestalt: CONCEPT, text, fields: ['name', 'aliases'], limit: SHOWN })}
      render={(c) => (
        <span className="flex min-w-0 items-baseline gap-2">
          <span>{str(c.value.name)}</span>
          {strings(c.value.aliases).length > 0 && <span className="min-w-0 text-xs text-base-content/50">{strings(c.value.aliases).join(', ')}</span>}
        </span>
      )}
      create={{
        offer: (name, found) => !found.some((c) => same(c, name)),
        label: (name) => <>Create “{name}”</>,
        run: async (name) => {
          const existing = await conceptNamed(read, name);
          onPick(existing ? existing.id : (await write.put({ gestalt: CONCEPT, name })).id);
        },
      }}
    />
  );
}
