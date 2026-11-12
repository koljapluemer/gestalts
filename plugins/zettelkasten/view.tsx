import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, Search } from 'lucide-react';
import { NoteCard, useDebounced } from '@gestalts/kit';
import {
  useDoc, useHost, useOutline, useParams, useQuery, useRead, useViewState, useWrite,
  type Json, type JsonMap, type OutlineEntry, type OutlineMark, type OutlineSpec, type OutlineStatus,
} from '@gestalts/view';

const NOTE = 'note@1';
const FOLLOWS = 'follows';
const BRANCHES = 'branches from';
const ROOT = 'zettelkasten-root';
const EXCLUDE = 'no-zettelkasten';
const SPEC: OutlineSpec = { gestalt: NOTE, field: 'relationships', follows: FOLLOWS, branches: BRANCHES, rootTag: ROOT, excludeTag: EXCLUDE };
const FIELDS = ['title', 'main', 'tags', 'relationships'];
const PAGE = 100;
const UNPLACED = { gestalt: NOTE, links: { none: [{ field: 'relationships', label: FOLLOWS }, { field: 'relationships', label: BRANCHES }] }, tags: { none: [ROOT, EXCLUDE] } };

type Rel = { to: string; label: string };
type Place = 'after' | 'branch';
const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];

function firstLine(v: JsonMap): string {
  if (typeof v.title === 'string' && v.title.trim()) return v.title.trim();
  if (typeof v.main === 'string' && v.main.trim()) return v.main.trim().split('\n')[0];
  return '(empty)';
}
const rels = (v: JsonMap): Rel[] => (Array.isArray(v.relationships) ? v.relationships.filter((r): r is Rel => Boolean(r) && typeof r === 'object' && !Array.isArray(r) && typeof (r as JsonMap).to === 'string') : []);
const isPlace = (r: Rel) => r.label === FOLLOWS || r.label === BRANCHES;
const tagsOf = (v: JsonMap): string[] => (Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === 'string') : []);

/** `v` with its places replaced by `keep` (none: unplaced), every other relationship as it was. */
function withPlaces(v: JsonMap, keep: Rel[]): JsonMap {
  const relationships = [...rels(v).filter((r) => !isPlace(r)), ...keep] as Json[];
  const { relationships: _, ...rest } = v;
  return relationships.length ? { ...rest, relationships } : rest;
}
function withTag(v: JsonMap, tag: string, on: boolean): JsonMap {
  const tags = tagsOf(v).filter((t) => t !== tag).concat(on ? [tag] : []);
  const { tags: _, ...rest } = v;
  return tags.length ? { ...rest, tags } : rest;
}

const STATUS: Record<OutlineStatus, string> = {
  root: 'The root',
  attached: 'In the Zettelkasten',
  floating: 'Placed, but not reaching the root',
  unplaced: 'Not placed yet',
  excluded: 'Kept out of the Zettelkasten',
};
const MARK: Record<OutlineMark['kind'], string> = {
  parentMissing: 'Its place is a note that doesn\'t exist (any more).',
  parentUnplaced: 'Its place is a note that isn\'t placed yet.',
  parentExcluded: 'Its place is a note kept out of the Zettelkasten.',
  cycle: 'Its places go round in a circle.',
  placedTwice: 'It is placed in more than one place.',
  fork: 'Another note already has the same place.',
  extraRoot: 'There is already a root.',
  rootPlaced: 'The root is placed somewhere too; that place is ignored.',
  excludedPlaced: 'It is tagged to be kept out, but placed.',
};

/** Changes one note, always from its whole current value (what's shown may be only some of its props). */
function useChange() {
  const read = useRead();
  const write = useWrite();
  const [error, setError] = useState<string>();
  const change = async (id: string, f: (v: JsonMap) => JsonMap) => {
    setError(undefined);
    try {
      const v = (await read.page({ gestalt: NOTE, ids: [id], limit: 1 })).items[0]?.value;
      if (!v) throw new Error('That note is gone.');
      await write.put(f(v));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return { change, error };
}
type Change = ReturnType<typeof useChange>['change'];

/**
 * Luhmann's Zettelkasten over notes: a note follows another (next after it) or branches from it (starts a sequence
 * under it), from one root tagged `zettelkasten-root`. One note at a time comes up to be placed, from those not placed
 * and not tagged `no-zettelkasten`; anything that doesn't add up is listed with what can be done about it. Param
 * `note`: the note in focus (to place, move or fix) instead of the next one up.
 */
export default function Zettelkasten() {
  const [params, setParams] = useParams();
  const focused = params.note ?? null;
  const [seed, setSeed] = useViewState<number>('seed', newSeed());
  const [expanded, setExpanded] = useViewState<string[]>('expanded', []);
  const [selected, setSelected] = useState<string | null>(null);
  const { change, error } = useChange();
  const { openView } = useHost();

  const inbox = useQuery(focused ? null : { ...UNPLACED, order: { seed }, limit: 1 });
  const subject = focused ?? inbox.items[0]?.id ?? null;
  const top = useOutline(SPEC, { children: null }, { fields: FIELDS, limit: PAGE });
  // while loading, as if there were one, so "Make it the root" doesn't flash up
  const hasRoot = top.loading || top.entries.length > 0;

  const focus = (id: string | null) => { setSelected(null); setParams(id ? { note: id } : {}); };
  const expand = (ids: string[]) => setExpanded([...new Set([...expanded, ...ids])]);
  const toggle = (id: string) => setExpanded(expanded.includes(id) ? expanded.filter((x) => x !== id) : [...expanded, id]);
  const place = async (target: string, how: Place) => {
    if (!subject) return;
    await change(subject, (v) => withPlaces(v, [{ to: target, label: how === 'after' ? FOLLOWS : BRANCHES }]));
    if (how === 'branch') expand([target]);
    setSelected(null);
  };
  const open = (id: string) => { void openView('note-crud', { note: id }); };
  const ctx: TreeCtx = { expanded, toggle, selected, select: setSelected, subject, place, focus, open, revealed: focused };

  return (
    <div className="h-full overflow-y-auto bg-base-100 md:flex md:overflow-hidden">
      <aside className="flex flex-col gap-4 border-base-300 p-3 md:w-[26rem] md:shrink-0 md:overflow-y-auto md:border-r">
        {error && <div role="alert" className="alert alert-error text-sm">{error}</div>}
        {inbox.error && <div role="alert" className="alert alert-error text-sm">{inbox.error}</div>}
        {subject
          ? <Subject key={subject} id={subject} fromInbox={!focused} hasRoot={hasRoot} change={change} expand={expand} focus={focus} open={open} skip={() => setSeed(newSeed())} />
          : !inbox.loading && <p className="p-4 text-center text-base-content/60">Every note is placed, or kept out.</p>}
        {subject && <Targets subject={subject} place={place} />}
        <Attention ctx={ctx} />
      </aside>
      <main className="min-w-0 flex-1 p-3 md:overflow-y-auto">
        <h2 className="mb-2 text-sm font-semibold uppercase text-base-content/60">Zettelkasten</h2>
        {top.error && <div role="alert" className="alert alert-error text-sm">{top.error}</div>}
        {!hasRoot && (
          <p className="text-base-content/60">No root yet. Make a note the root to start: everything else is placed after it or under it.</p>
        )}
        <Rows result={top} depth={0} ctx={ctx} />
      </main>
    </div>
  );
}

/** The note being placed (or moved, or fixed): what it is, where it is, and what can be done with it. */
function Subject({ id, fromInbox, hasRoot, change, expand, focus, open, skip }: {
  id: string; fromInbox: boolean; hasRoot: boolean; change: Change; expand: (ids: string[]) => void;
  focus: (id: string | null) => void; open: (id: string) => void; skip: () => void;
}) {
  const note = useDoc(NOTE, id);
  const located = useOutline(SPEC, { locate: [id] }, { fields: FIELDS }).entries[0];
  const path = located?.path;
  const pathKey = path?.map((p) => p.id).join('/');
  useEffect(() => {
    if (!fromInbox && path?.length) expand(path.map((p) => p.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opens the tree to it once per place it is at, then the user may close it
  }, [pathKey]);
  if (!note) return located === undefined ? null : <p className="text-base-content/60">That note is gone. <button type="button" className="link" onClick={() => focus(null)}>Next</button></p>;
  const v = note.value;
  const places = rels(v).filter(isPlace);
  const tags = tagsOf(v);
  return (
    <section className="card card-border bg-base-100">
      <div className="card-body gap-3 p-4">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-semibold">{located ? STATUS[located.status] : '…'}</span>
          <span className="flex-1" />
          <button type="button" className="btn btn-ghost btn-xs" title="Open in Notes" onClick={() => open(id)}><ExternalLink className="size-4" /></button>
        </div>
        {path && path.length > 0 && <p className="truncate text-xs text-base-content/60">{path.map((p) => firstLine(p.value)).join(' › ')}</p>}
        <div className="max-h-64 overflow-y-auto"><NoteCard value={v} /></div>
        {located?.marks.map((m, i) => <Fix key={i} id={id} mark={m} value={v} change={change} focus={focus} />)}
        <div className="flex flex-wrap gap-2">
          {fromInbox && <button type="button" className="btn btn-sm" onClick={skip}>Skip</button>}
          {!fromInbox && <button type="button" className="btn btn-sm" onClick={() => focus(null)}>Next unplaced</button>}
          {places.length > 0 && (
            <button type="button" className="btn btn-sm" onClick={() => {
              if (located?.hasChildren && !confirm('What branches from it will float until it is placed again. Unplace it?')) return;
              void change(id, (x) => withPlaces(x, []));
            }}>Unplace</button>
          )}
          {!tags.includes(EXCLUDE) && places.length === 0 && !tags.includes(ROOT) && (
            <button type="button" className="btn btn-sm" onClick={() => void change(id, (x) => withTag(x, EXCLUDE, true))}>Keep out</button>
          )}
          {tags.includes(EXCLUDE) && <button type="button" className="btn btn-sm" onClick={() => void change(id, (x) => withTag(x, EXCLUDE, false))}>Let in</button>}
          {!hasRoot && places.length === 0 && !tags.includes(EXCLUDE) && (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void change(id, (x) => withTag(x, ROOT, true))}>Make it the root</button>
          )}
        </div>
        {located?.status !== 'root' && (
          <p className="text-xs text-base-content/60">
            {places.length ? 'To move it, pick' : 'To place it, pick'} a note in the tree or search: it goes after that note, or starts a branch under it.
          </p>
        )}
      </div>
    </section>
  );
}

/** What can be done about one mark. */
function Fix({ id, mark, value, change, focus }: { id: string; mark: OutlineMark; value: JsonMap; change: Change; focus: (id: string | null) => void }) {
  const places = rels(value).filter(isPlace);
  const targets = useQuery(mark.kind === 'placedTwice' ? { gestalt: NOTE, ids: places.map((p) => p.to), fields: ['title', 'main'] } : null).items;
  const title = (to: string) => { const t = targets.find((i) => i.id === to); return t ? firstLine(t.value) : 'a missing note'; };
  return (
    <div role="alert" className="alert alert-warning flex flex-col items-start gap-2 text-sm">
      <span>{MARK[mark.kind]}</span>
      <div className="flex flex-wrap gap-2">
        {mark.kind === 'parentUnplaced' && mark.target && <button type="button" className="btn btn-xs" onClick={() => focus(mark.target!)}>Place that note first</button>}
        {mark.kind === 'placedTwice' && places.map((p, i) => (
          <button key={i} type="button" className="btn btn-xs" onClick={() => void change(id, (x) => withPlaces(x, [p]))}>
            Keep: {p.label === FOLLOWS ? 'after' : 'under'} {title(p.to)}
          </button>
        ))}
        {(mark.kind === 'extraRoot' || mark.kind === 'rootPlaced') && (
          <button type="button" className="btn btn-xs" onClick={() => void change(id, (x) => (mark.kind === 'extraRoot' ? withTag(x, ROOT, false) : withPlaces(x, [])))}>
            {mark.kind === 'extraRoot' ? 'Not the root' : 'Remove its place'}
          </button>
        )}
        {mark.kind === 'excludedPlaced' && <button type="button" className="btn btn-xs" onClick={() => void change(id, (x) => withTag(x, EXCLUDE, false))}>Let it in</button>}
      </div>
    </div>
  );
}

/** Finding where the subject goes by searching, with where each match is. */
function Targets({ subject, place }: { subject: string; place: (target: string, how: Place) => Promise<void> }) {
  const [search, setSearch] = useViewState<string>('search', '');
  const text = useDebounced(search, 200).trim();
  const found = useQuery(text ? { gestalt: NOTE, text, limit: 20, fields: ['title', 'main'] } : null);
  const ids = found.items.map((i) => i.id);
  const located = useOutline(SPEC, ids.length ? { locate: ids } : null, { fields: ['title', 'main'], subject }).entries;
  return (
    <section className="flex flex-col gap-2">
      <label className="input input-sm w-full">
        <Search className="size-4 opacity-60" />
        <input type="search" placeholder="Search for where it goes" value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      {text && !found.loading && !ids.length && <p className="text-sm text-base-content/60">Nothing found.</p>}
      <ul className="flex flex-col gap-1">
        {located.map((e) => (
          <li key={e.item.id} className="rounded-box bg-base-200 p-2 text-sm">
            {e.path && e.path.length > 0 && <p className="truncate text-xs text-base-content/60">{e.path.map((p) => firstLine(p.value)).join(' › ')}</p>}
            <p className="truncate">{firstLine(e.item.value)}</p>
            <PlaceButtons entry={e} subject={subject} below={e.belowSubject === true} place={place} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Why a note can't take the subject, if it can't. */
function refusal(e: OutlineEntry, subject: string, below: boolean): string | null {
  if (e.item.id === subject) return 'This is the note itself.';
  if (below) return 'This is placed below the note itself.';
  if (e.status !== 'root' && e.status !== 'attached') return `${STATUS[e.status]}: place it first.`;
  return null;
}

function PlaceButtons({ entry, subject, below, place }: { entry: OutlineEntry; subject: string; below: boolean; place: (target: string, how: Place) => Promise<void> }) {
  const no = refusal(entry, subject, below);
  if (no) return <p className="mt-1 text-xs text-base-content/60">{no}</p>;
  return (
    <div className="mt-1 flex gap-2">
      <button type="button" className="btn btn-xs btn-primary" onClick={() => void place(entry.item.id, 'after')}>After this</button>
      <button type="button" className="btn btn-xs btn-primary" onClick={() => void place(entry.item.id, 'branch')}>Branch from this</button>
    </div>
  );
}

/** What starts a floating chain: what hangs on it isn't in the tree, so it's shown here. */
const FLOATS: OutlineMark['kind'][] = ['parentMissing', 'parentUnplaced', 'parentExcluded', 'cycle', 'extraRoot'];

/** Everything that doesn't add up, a page at a time; what floats can be unfolded like the tree. */
function Attention({ ctx }: { ctx: TreeCtx }) {
  const loose = useOutline(SPEC, 'loose', { fields: ['title', 'main'], limit: 50 });
  const [unfolded, setUnfolded] = useViewState<string[]>('unfolded', []);
  if (!loose.entries.length) return null;
  return (
    <section className="flex flex-col gap-1">
      <h2 className="text-sm font-semibold uppercase text-base-content/60">Needs attention</h2>
      <ul className="flex flex-col gap-1">
        {loose.entries.map((e) => {
          const id = e.item.id;
          const floats = e.marks.some((m) => FLOATS.includes(m.kind));
          const open = unfolded.includes(id);
          return (
            <li key={id}>
              <div className="flex items-start gap-1">
                {floats
                  ? <button type="button" className="btn btn-ghost btn-xs btn-square mt-1.5" aria-label={open ? 'Hide what hangs on it' : 'Show what hangs on it'} onClick={() => setUnfolded(open ? unfolded.filter((x) => x !== id) : [...unfolded, id])}>{open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</button>
                  : <span className="inline-block w-6 shrink-0" />}
                <button type="button" className="min-w-0 flex-1 rounded-box p-2 text-left text-sm hover:bg-base-200" onClick={() => ctx.focus(id)}>
                  <span className="block truncate">{firstLine(e.item.value)}</span>
                  <span className="block text-xs text-base-content/60">{e.marks.map((m) => MARK[m.kind]).join(' ')}</span>
                </button>
              </div>
              {open && <Floating from={id} ctx={ctx} />}
            </li>
          );
        })}
      </ul>
      {loose.hasMore && <button type="button" className="btn btn-sm btn-ghost" onClick={loose.more}>More</button>}
    </section>
  );
}

type TreeCtx = {
  expanded: string[];
  toggle: (id: string) => void;
  selected: string | null;
  select: (id: string | null) => void;
  subject: string | null;
  place: (target: string, how: Place) => Promise<void>;
  focus: (id: string) => void;
  open: (id: string) => void;
  /** the note in focus, scrolled to when shown */
  revealed: string | null;
};

function Rows({ result, depth, ctx }: { result: ReturnType<typeof useOutline>; depth: number; ctx: TreeCtx }) {
  return (
    <>
      <ul>
        {result.entries.map((e) => <Row key={e.item.id} entry={e} depth={depth} ctx={ctx} />)}
      </ul>
      {result.hasMore && <button type="button" className="btn btn-xs btn-ghost" style={{ marginLeft: `${depth * 1.25 + 1.5}rem` }} onClick={result.more}>More</button>}
    </>
  );
}

/** A floating yml and what follows it, as tree rows. */
function Floating({ from, ctx }: { from: string; ctx: TreeCtx }) {
  const result = useOutline(SPEC, { sequence: from }, { fields: FIELDS, limit: PAGE });
  if (result.error) return <div role="alert" className="alert alert-error text-sm">{result.error}</div>;
  return <div className="ml-6 border-l border-base-300 pl-1"><Rows result={result} depth={0} ctx={ctx} /></div>;
}

function Children({ of, depth, ctx }: { of: string; depth: number; ctx: TreeCtx }) {
  const result = useOutline(SPEC, { children: of }, { fields: FIELDS, limit: PAGE });
  if (result.error) return <div role="alert" className="alert alert-error text-sm">{result.error}</div>;
  return <Rows result={result} depth={depth} ctx={ctx} />;
}

function Row({ entry, depth, ctx }: { entry: OutlineEntry; depth: number; ctx: TreeCtx }) {
  const id = entry.item.id;
  const open = ctx.expanded.includes(id);
  const selected = ctx.selected === id;
  const isSubject = ctx.subject === id;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ctx.revealed === id) ref.current?.scrollIntoView({ block: 'nearest' }); }, [ctx.revealed, id]);
  return (
    <li>
      <div ref={ref} className={`flex items-center gap-1 rounded-box py-0.5 pr-1 ${selected ? 'bg-base-200' : ''} ${isSubject ? 'outline outline-1 outline-primary' : ''}`} style={{ paddingLeft: `${depth * 1.25}rem` }}>
        {entry.hasChildren
          ? <button type="button" className="btn btn-ghost btn-xs btn-square" aria-label={open ? 'Collapse' : 'Expand'} onClick={() => ctx.toggle(id)}>{open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</button>
          : <span className="inline-block w-6 shrink-0" />}
        <button type="button" className="min-w-0 flex-1 truncate py-1 text-left" onClick={() => ctx.select(selected ? null : id)}>
          {firstLine(entry.item.value)}
        </button>
        {entry.marks.length > 0 && <span className="badge badge-warning badge-xs" title={entry.marks.map((m) => MARK[m.kind]).join(' ')}>!</span>}
      </div>
      {selected && <RowActions entry={entry} depth={depth} ctx={ctx} />}
      {open && <Children of={id} depth={depth + 1} ctx={ctx} />}
    </li>
  );
}

/** For a selected row: put the subject here, or work on this note. */
function RowActions({ entry, depth, ctx }: { entry: OutlineEntry; depth: number; ctx: TreeCtx }) {
  const id = entry.item.id;
  const subject = ctx.subject;
  // whether the subject would end up below itself is the core's to say
  const located = useOutline(SPEC, subject ? { locate: [id] } : null, { fields: [], subject: subject ?? undefined }).entries[0];
  return (
    <div className="flex flex-wrap items-center gap-2 py-1" style={{ paddingLeft: `${depth * 1.25 + 1.75}rem` }}>
      {subject && located && <PlaceButtons entry={entry} subject={subject} below={located.belowSubject === true} place={ctx.place} />}
      <button type="button" className="btn btn-xs" onClick={() => ctx.focus(id)}>Focus</button>
      <button type="button" className="btn btn-xs btn-ghost" title="Open in Notes" onClick={() => ctx.open(id)}><ExternalLink className="size-4" /></button>
    </div>
  );
}

