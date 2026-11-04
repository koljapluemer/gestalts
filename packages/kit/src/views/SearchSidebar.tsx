import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { definePerspective, tags as tagsOf, type Query } from '@gestalts/sdk';
import { NoteResultList, buildIndex, search, type NoteAction } from '../widgets';

export type { NoteAction };

const PAGE = 50;
const TOP_TAGS = 12;

type Props = {
  /** a note was picked */
  onOpen: (key: string) => void;
  /** given: a "+" asks for a new note, prefilled from the query and tag filter */
  onCreate?: (prefill: { title?: string; tags: string[] }) => void;
  /** keys currently open elsewhere, shown marked */
  openKeys?: string[];
  /** what the hosting pane can do with a result, besides opening it */
  actions?: NoteAction[];
};

/** Find any note by text, tag or gestalt; ask for new ones. `/` focuses the search. */
export const SearchSidebar = definePerspective<{ all: Query }, Props>({
  id: 'search-sidebar',
  title: 'Search',
  data: { all: {} },
  Component: ({ data, onOpen, onCreate, openKeys = [], actions = [] }) => {
    const [query, setQuery] = useState('');
    const [tagFilter, setTagFilter] = useState<string[]>([]);
    const [active, setActive] = useState(0);
    const [limit, setLimit] = useState(PAGE);
    const input = useRef<HTMLInputElement>(null);
    const deferred = useDeferredValue(query);

    const index = useMemo(() => buildIndex(data.all), [data.all]);
    const result = useMemo(() => search(index, deferred, tagFilter), [index, deferred, tagFilter]);
    const shown = result.notes.slice(0, limit);
    const topTags = useMemo(() => {
      const counts = new Map<string, number>();
      for (const n of data.all) for (const t of tagsOf(n)) counts.set(t, (counts.get(t) ?? 0) + 1);
      return [...counts].sort((a, b) => b[1] - a[1]).slice(0, TOP_TAGS).map(([t]) => t);
    }, [data.all]);

    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        const t = e.target as HTMLElement | null;
        const typing = t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
        if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          input.current?.focus();
          input.current?.select();
        }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, []);

    const reset = () => { setActive(0); setLimit(PAGE); };

    // the query becomes the title unless it's filters
    const prefill = () => {
      const title = query.trim() && !query.includes(':') && !query.includes('#') ? query.trim() : undefined;
      return { ...(title ? { title } : {}), tags: tagFilter };
    };

    return (
      <div className="flex h-full min-h-0 flex-col gap-2 p-3">
        <div className="flex gap-2">
          <label className="input input-sm flex-1">
            <Search className="size-4 opacity-50" />
            <input
              ref={input}
              type="search"
              placeholder="Search  (/)"
              value={query}
              onChange={(e) => { setQuery(e.target.value); reset(); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (shown.length ? (a + 1) % shown.length : 0)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (shown.length ? (a - 1 + shown.length) % shown.length : 0)); }
                else if (e.key === 'Enter') { const n = shown[active] ?? shown[0]; if (n) onOpen(n.key); }
                else if (e.key === 'Escape') input.current?.blur();
              }}
            />
          </label>
          {onCreate && (
            <button type="button" className="btn btn-sm btn-primary btn-square" title="New note" onClick={() => onCreate(prefill())}>
              <Plus className="size-4" />
            </button>
          )}
        </div>
        {topTags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {topTags.map((t) => {
              const on = tagFilter.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  className={`badge badge-sm cursor-pointer ${on ? 'badge-primary' : 'badge-ghost'}`}
                  onClick={() => { setTagFilter(on ? tagFilter.filter((x) => x !== t) : [...tagFilter, t]); reset(); }}
                >
                  {t}
                </button>
              );
            })}
          </div>
        )}
        <p className="text-xs text-base-content/50">
          {result.notes.length} of {data.all.length} notes · <code>#tag</code> <code>gestalt:name@1</code> <code>-word</code>
        </p>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <NoteResultList notes={shown} terms={result.terms} active={active} marked={new Set(openKeys)} onOpen={onOpen} actions={actions} />
          {result.notes.length > limit && (
            <button type="button" className="btn btn-ghost btn-sm btn-block" onClick={() => setLimit(limit + PAGE)}>Show more</button>
          )}
        </div>
      </div>
    );
  },
});
