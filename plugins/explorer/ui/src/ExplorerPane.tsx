import { definePane } from '@gestalts/sdk';
import { Note, SearchLayout, useUrlList } from '@gestalts/kit';

/** The search on the right (a drawer on small screens) opens notes here, newest first; its "+" starts a new one. */
export const ExplorerPane = definePane({
  title: 'Explorer',
  Component: () => {
    const [open, setOpen] = useUrlList('open');
    const show = (key: string) => setOpen([key, ...open.filter((k) => k !== key)]);
    const close = (key: string) => setOpen(open.filter((k) => k !== key));
    return (
      <SearchLayout onOpen={show} openKeys={open}>
        <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
          {!open.length && <p className="p-8 text-center text-base-content/60">Open a note from the search, or start one with +.</p>}
          {open.map((key, i) => (
            <Note key={key} noteKey={key} persist={`explorer:${key}`} autofocus={i === 0} onOpen={show} onClose={() => close(key)} onDeleted={() => close(key)} />
          ))}
        </div>
      </SearchLayout>
    );
  },
});
