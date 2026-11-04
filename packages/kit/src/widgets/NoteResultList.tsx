import type { ReactNode } from 'react';
import type { IndexedNote } from '@gestalts/sdk';
import { NoteLine } from '../components';

/** Something a list's owner can do with a note, shown as an icon button on each result it applies to. */
export type NoteAction = {
  icon: ReactNode;
  title: string;
  run: (key: string) => void;
  applies?: (note: IndexedNote) => boolean;
};

type Props = {
  notes: IndexedNote[];
  terms: string[];
  /** index of the keyboard-selected result */
  active: number;
  /** keys shown as already open */
  marked?: Set<string>;
  onOpen: (key: string) => void;
  actions?: NoteAction[];
};

/** Search results; keyboard navigation is driven by the owner of `active`. */
export function NoteResultList({ notes, terms, active, marked, onOpen, actions = [] }: Props) {
  if (!notes.length) return <p className="px-3 py-6 text-center text-sm text-base-content/60">No notes found.</p>;
  return (
    <ul className="menu menu-sm w-full p-0">
      {notes.map((n, i) => (
        <li key={n.key} className="flex-row flex-nowrap items-center">
          <button
            type="button"
            // keep focus in the search field
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onOpen(n.key)}
            className={[
              'block min-w-0 flex-1 text-left',
              i === active ? 'menu-active' : '',
              marked?.has(n.key) ? 'border-l-2 border-primary/60' : '',
            ].join(' ')}
          >
            <NoteLine note={n} terms={terms} />
            {n.gestalts.length > 0 && <span className="block truncate text-xs text-base-content/50">{n.gestalts.join(' · ')}</span>}
          </button>
          {/* not direct children of the menu item, whose styles would squash them */}
          <span className="flex shrink-0 gap-0.5 bg-transparent p-0 hover:bg-transparent">
            {actions.filter((a) => a.applies?.(n) ?? true).map((a) => (
              <button key={a.title} type="button" className="btn btn-ghost btn-xs btn-square" title={a.title}
                      onMouseDown={(e) => e.preventDefault()} onClick={() => a.run(n.key)}>
                {a.icon}
              </button>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}
