import { useDeferredValue, useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { useQuery, type Query } from '@gestalts/sdk';
import { NoteResultList } from './NoteResultList';
import { buildIndex, search } from './noteSearch';

type Props = {
  onPick: (key: string) => void;
  /** which notes to offer; all by default */
  query?: Query;
  placeholder?: string;
  autofocus?: boolean;
  limit?: number;
  /** keys not to offer (the note being linked from) */
  exclude?: string[];
  /** offers a new note from the text typed; Enter makes one when nothing is found */
  onCreate?: (text: string) => void;
  disabled?: boolean;
};

/** A search field with its results, for picking a note (to add, to link). Enter picks the first. */
export function NotePicker({ onPick, query = {}, placeholder = 'Search notes', autofocus, limit = 12, exclude, onCreate, disabled }: Props) {
  const notes = useQuery(query);
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const deferred = useDeferredValue(text);
  const index = useMemo(() => buildIndex(notes), [notes]);
  const result = useMemo(() => search(index, deferred), [index, deferred]);
  const shown = (exclude?.length ? result.notes.filter((n) => !exclude.includes(n.key)) : result.notes).slice(0, limit);
  const typed = text.trim();
  const create = () => { if (onCreate && typed) { onCreate(typed); setText(''); } };
  return (
    <div className="flex min-h-0 flex-col gap-1">
      <label className="input input-sm w-full">
        <Search className="size-4 opacity-50" />
        <input
          type="search"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- opened on purpose, to type into
          autoFocus={autofocus}
          placeholder={placeholder}
          disabled={disabled}
          value={text}
          onChange={(e) => { setText(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, shown.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter') { const n = shown[active] ?? shown[0]; if (n) onPick(n.key); else create(); }
          }}
        />
      </label>
      {onCreate && typed && (
        <button type="button" className="btn btn-ghost btn-sm justify-start font-normal" disabled={disabled} onClick={create}>
          <Plus className="size-4" />New note: <span className="truncate">{typed}</span>
        </button>
      )}
      <div className="min-h-0 overflow-y-auto">
        <NoteResultList notes={shown} terms={result.terms} active={active} onOpen={onPick} />
      </div>
    </div>
  );
}
