import { useState, type ReactNode } from 'react';
import { PanelRight } from 'lucide-react';
import { useHost } from '@gestalts/sdk';
import { SearchSidebar, type NoteAction } from './SearchSidebar';

type Prefill = { title?: string; tags: string[] };

type Props = {
  children: ReactNode;
  /** what results offer besides opening them */
  actions?: NoteAction[];
  /** a result was opened (or a note created); by default the host opens it (`openNote`, its editor over the pane) */
  onOpen?: (key: string) => void;
  /** the "+" was pressed; by default the host's new-note form opens (`createNote`) */
  onCreate?: (prefill: Prefill) => void;
  /** keys shown marked in the results */
  openKeys?: string[];
};

/** A pane's content with the search on the right (a drawer on small screens). */
export function SearchLayout({ children, actions, onOpen, onCreate, openKeys }: Props) {
  const host = useHost();
  const [drawer, setDrawer] = useState(false);
  const openWith = onOpen ?? host.openNote;
  const createWith = onCreate ?? host.createNote;
  const open = openWith && ((key: string) => { setDrawer(false); openWith(key); });
  const create = createWith && ((prefill: Prefill) => { setDrawer(false); createWith(prefill); });
  const act = (actions ?? []).map((a) => ({ ...a, run: (key: string) => { setDrawer(false); a.run(key); } }));
  return (
    <div className="drawer drawer-end h-full lg:drawer-open">
      <input id="pane-search" type="checkbox" className="drawer-toggle" checked={drawer} onChange={(e) => setDrawer(e.target.checked)} />
      <div className="drawer-content flex min-h-0 flex-col">
        <div className="flex justify-end px-3 pt-2 lg:hidden">
          <label htmlFor="pane-search" className="btn btn-sm btn-ghost gap-1"><PanelRight className="size-4" /> Search</label>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
      <div className="drawer-side z-40 h-full lg:h-auto">
        <label htmlFor="pane-search" aria-label="Close search" className="drawer-overlay" />
        <aside className="h-full w-[22rem] max-w-[85vw] border-l border-base-300 bg-base-100">
          <SearchSidebar onOpen={open ?? (() => {})} onCreate={create} openKeys={openKeys} actions={act} />
        </aside>
      </div>
    </div>
  );
}
