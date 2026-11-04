import { noteLabel, relationships, type IndexedNote, type Query, definePerspective } from '@gestalts/sdk';
import { OLD_CANVASES } from './canvasNote';

type Props = {
  /** a host note was picked: its key */
  onOpen: (key: string) => void;
  /** the key of the host open now */
  current?: string;
};

/** The notes that have a canvas (as a key, or still as an old `canvas@1` note), by label. */
export const CanvasList = definePerspective<{ hosts: Query; canvases: Query }, Props>({
  id: 'canvas-list',
  title: 'Canvases',
  data: { hosts: { gestalt: 'canvas@2' }, canvases: { ...OLD_CANVASES, tagsNone: ['retired'] } },
  Component: ({ data, repo, onOpen, current }) => {
    const byKey = new Map<string, IndexedNote>(data.hosts.map((n) => [n.key, n]));
    for (const c of data.canvases) {
      for (const r of relationships(c)) {
        const key = r.label === 'canvas-of' ? repo.keyOf(r.target) : undefined;
        const n = key ? repo.get(key) : undefined;
        if (n) byKey.set(n.key, n);
      }
    }
    const hosts = [...byKey.values()].sort((a, b) => noteLabel(a).localeCompare(noteLabel(b)));
    if (!hosts.length) return <p className="p-3 text-sm text-base-content/60">No canvases yet. Open any note as a canvas from the search.</p>;
    return (
      <ul className="menu menu-sm w-full">
        {hosts.map((n) => (
          <li key={n.key}>
            <button type="button" className={`block truncate text-left ${n.key === current ? 'menu-active' : ''}`} onClick={() => onOpen(n.key)}>{noteLabel(n)}</button>
          </li>
        ))}
      </ul>
    );
  },
});
