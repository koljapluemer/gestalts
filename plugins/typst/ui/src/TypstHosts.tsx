import { noteLabel, relationships, type IndexedNote, type Query, definePerspective } from '@gestalts/sdk';
import { DOCUMENT_OF } from './typstDocument';

type Props = {
  /** a note with Typst documents was picked: its key */
  onOpen: (key: string) => void;
  current?: string;
};

/** The notes that have Typst documents, by label. */
export const TypstHosts = definePerspective<{ documents: Query }, Props>({
  id: 'typst-hosts',
  title: 'Typst documents',
  data: { documents: { tagsAll: ['typst'] } },
  Component: ({ data, repo, onOpen, current }) => {
    const hosts = new Map<string, IndexedNote>();
    for (const d of data.documents) {
      for (const r of relationships(d)) {
        const key = r.label === DOCUMENT_OF ? repo.keyOf(r.target) : undefined;
        const n = key ? repo.get(key) : undefined;
        if (n) hosts.set(n.key, n);
      }
    }
    const sorted = [...hosts.values()].sort((a, b) => noteLabel(a).localeCompare(noteLabel(b)));
    if (!sorted.length) return <p className="p-3 text-sm text-base-content/60">No notes with a Typst document yet. Open one from the search.</p>;
    return (
      <ul className="menu menu-sm w-full">
        {sorted.map((n) => (
          <li key={n.key}>
            <button type="button" className={`block truncate text-left ${n.key === current ? 'menu-active' : ''}`} onClick={() => onOpen(n.key)}>{noteLabel(n)}</button>
          </li>
        ))}
      </ul>
    );
  },
});
