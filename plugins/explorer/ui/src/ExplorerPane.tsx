import { definePane } from '@gestalts/sdk';
import { SearchLayout, UniversalEditor, useUrlList } from '@gestalts/kit';

/** The search on the right (a drawer on small screens) opens notes in the editors here. */
export const ExplorerPane = definePane({
  title: 'Explorer',
  Component: () => {
    const [open, setOpen] = useUrlList('open');
    const show = (key: string) => setOpen([key, ...open.filter((k) => k !== key)]);
    return (
      <SearchLayout onOpen={show} openKeys={open}>
        <div className="h-full overflow-y-auto">
          <UniversalEditor open={open} onClose={(key) => setOpen(open.filter((k) => k !== key))} onOpen={show} />
        </div>
      </SearchLayout>
    );
  },
});
