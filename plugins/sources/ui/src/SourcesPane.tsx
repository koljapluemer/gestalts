import { BookOpen } from 'lucide-react';
import { definePane, tags, useHost } from '@gestalts/sdk';
import { SearchLayout, useUrlList } from '@gestalts/kit';
import { Sources } from './Sources';

/** Bibliographic sources: the list and the one open; a source found in the search opens here. */
function SourcesPaneView() {
  const [[open] = [], setOpen] = useUrlList('source');
  const edit = useHost().openNote;
  return (
    <SearchLayout openKeys={open ? [open] : []} actions={[
      { icon: <BookOpen className="size-3.5" />, title: 'Open in Sources', run: (k) => setOpen([k]), applies: (n) => tags(n).includes('source') },
    ]}>
      <Sources open={open} onSelect={(k) => setOpen(k ? [k] : [])} onOpen={edit} />
    </SearchLayout>
  );
}

export const SourcesPane = definePane({ title: 'Sources', Component: SourcesPaneView });
