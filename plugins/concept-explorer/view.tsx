import { useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, BookPlus, Pencil, Plus, Trash2, Unlink, X } from 'lucide-react';
import { AddSource, ConfirmDialog, Modal, SOURCE_LABEL, byline, sourceTitle, useDebounced } from '@gestalts/kit';
import { useBeliefs, useQuery, useRead, useViewState, useWrite, type Item, type JsonMap } from '@gestalts/view';

const CONCEPT = 'concept@2';
const NOTE = 'note@1';
const SOURCE = 'source@1';
const LINK = 'concept-link@1';
/** how a note relates to the concept unless the user says otherwise */
const LABEL = 'sheds light on';
const SAVE_AFTER_MS = 500;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const fold = (s: string) => s.trim().toLowerCase();

/** A uuid v4 for a note before it's written, so it keeps its place on screen (a sandboxed frame has no randomUUID). */
function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

type Relationship = { to: string; label: string };
const relationsOf = (v: JsonMap | undefined): Relationship[] => (Array.isArray(v?.relationships) ? (v.relationships as Relationship[]) : []);

/** `base` with `main` and `relationships` replaced, leaving out what's empty. */
function noteValue(base: JsonMap, main: string, relationships: Relationship[]): JsonMap {
  const { main: _main, relationships: _relationships, ...rest } = base;
  return { ...rest, ...(main.trim() ? { main } : {}), ...(relationships.length ? { relationships } : {}) };
}

/** `relationships` with the one to `concept` labelled `label` (added if missing). */
function withLabel(relationships: Relationship[], concept: string, label: string): Relationship[] {
  const l = label.trim() || LABEL;
  const i = relationships.findIndex((r) => r.to === concept);
  return i < 0 ? [...relationships, { to: concept, label: l }] : relationships.map((r, j) => (j === i ? { ...r, label: l } : r));
}

// ---- finding or making a concept ----

function ConceptPicker({ onOpen, autoFocus }: { onOpen: (id: string) => void; autoFocus?: boolean }) {
  const read = useRead();
  const write = useWrite();
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const text = useDebounced(search, 150).trim();
  const name = search.trim();
  const { items } = useQuery(text ? { gestalt: CONCEPT, text, fields: ['name', 'aliases'], limit: 8 } : null);
  /** named so, or going by that name */
  const same = (c: Item) => [str(c.value.name), ...strings(c.value.aliases)].some((n) => fold(n) === fold(name));
  /** the concept named exactly so, else a new one; asked afresh, as the suggestions may lag behind the typing */
  const openOrCreate = async () => {
    if (!name || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const { items: found } = await read.page({ gestalt: CONCEPT, text: name, fields: ['name', 'aliases'], limit: 50 });
      const existing = found.find((c) => fold(str(c.value.name)) === fold(name)) ?? found.find(same);
      onOpen(existing ? existing.id : (await write.put({ gestalt: CONCEPT, name })).id);
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-1">
      <input className="input w-full" type="search" placeholder="Find or create a concept…" value={search} autoFocus={autoFocus}
             onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void openOrCreate(); }} />
      {text && items.map((c) => (
        <button key={c.id} type="button" className="btn btn-ghost btn-sm justify-start gap-2 font-normal" onClick={() => onOpen(c.id)}>
          <span className="truncate">{str(c.value.name)}</span>
          {strings(c.value.aliases).length > 0 && <span className="min-w-0 truncate text-xs text-base-content/50">{strings(c.value.aliases).join(', ')}</span>}
        </button>
      ))}
      {name && !items.some(same) && (
        <button type="button" className="btn btn-ghost btn-sm justify-start truncate font-normal" disabled={busy} onClick={() => void openOrCreate()}>
          <Plus className="size-4" /> Create “{name}”
        </button>
      )}
      {error && <p role="alert" className="text-sm text-error">{error}</p>}
    </div>
  );
}

// ---- one note about the concept ----

function Sources({ relationships, concept, onChange }: {
  relationships: Relationship[]; concept: string; onChange: (r: Relationship[]) => void;
}) {
  const write = useWrite();
  const [deleting, setDeleting] = useState<{ source: Item; index: number }>();
  const targets = [...new Set(relationships.filter((r) => r.to !== concept).map((r) => r.to))];
  const { items } = useQuery(targets.length ? { gestalt: SOURCE, ids: targets, fields: ['title', 'key', 'author', 'editor', 'date'], limit: targets.length } : null);
  const sources = new Map(items.map((s) => [s.id, s]));
  const rows = relationships.flatMap((r, i) => { const s = sources.get(r.to); return s ? [{ r, i, s }] : []; });
  const remove = async () => {
    if (!deleting) return;
    await write.remove(deleting.source.id);
    onChange(relationships.filter((_, j) => j !== deleting.index));
  };
  if (!rows.length) return null;
  return <>
    <ul className="flex flex-col gap-1">
      {rows.map(({ r, i, s }) => (
        <li key={`${r.to}:${i}`} className="flex items-center gap-1 rounded-box bg-base-200 px-2 py-1">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{sourceTitle(s.value)}</span>
            <span className="block truncate text-xs text-base-content/60">
              {[byline(s.value), r.label !== SOURCE_LABEL ? r.label.replace(/^source\s*/, '') : ''].filter(Boolean).join(' · ')}
            </span>
          </span>
          <button type="button" className="btn btn-ghost btn-xs btn-square" title="Detach the source from this note" onClick={() => onChange(relationships.filter((_, j) => j !== i))}><Unlink className="size-3" /></button>
          <button type="button" className="btn btn-ghost btn-xs btn-square" title="Delete the source" onClick={() => setDeleting({ source: s, index: i })}><Trash2 className="size-3" /></button>
        </li>
      ))}
    </ul>
    {deleting && (
      <ConfirmDialog title={`Delete ${sourceTitle(deleting.source.value)}?`} onClose={() => setDeleting(undefined)} onConfirm={remove}>
        Other notes about this source will stay, pointing at nothing. This cannot be undone.
      </ConfirmDialog>
    )}
  </>;
}

/**
 * One note relating to the concept: how it relates, its main text and its sources, saved as it's typed. Without `note`,
 * it's not written yet (or not back from the index yet); it's written once it has text or a source.
 */
function NoteGroup({ id, note, concept, onCreated, onGone, onError }: {
  id: string; note?: Item; concept: string; onCreated: (id: string) => void; onGone: (id: string) => void; onError: (e: unknown) => void;
}) {
  const write = useWrite();
  const savedRelations = relationsOf(note?.value);
  const savedLabel = savedRelations.find((r) => r.to === concept)?.label ?? LABEL;
  const savedMain = str(note?.value.main);
  const [main, setMain] = useState(savedMain);
  const [label, setLabel] = useState(savedLabel === LABEL ? '' : savedLabel);
  const [dirty, setDirty] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [written, setWritten] = useState(!!note);
  // what saving needs, current in callbacks that outlive a render
  const latest = useRef({ note, main, label, dirty, written });
  useEffect(() => { latest.current = { note, main, label, dirty, written }; });
  const edits = useRef(0);

  // changes from elsewhere show unless there's typing not saved yet (or the note isn't back from the index)
  const known = !!note;
  useEffect(() => { if (known && !dirty) setMain(savedMain); }, [savedMain, dirty, known]);
  useEffect(() => { if (known && !dirty) setLabel(savedLabel === LABEL ? '' : savedLabel); }, [savedLabel, dirty, known]);

  const put = async (relationships?: Relationship[]) => {
    const { note: n, main: m, label: l, written: w } = latest.current;
    const base = n?.value ?? { id, gestalt: NOTE };
    const rels = withLabel(relationships ?? relationsOf(n?.value), concept, l);
    if (!w && !m.trim() && rels.length < 2) return;
    const edit = edits.current;
    await write.put(noteValue(base, m, rels));
    if (edits.current === edit) setDirty(false);
    if (!w) { setWritten(true); onCreated(id); }
  };
  const save = (relationships?: Relationship[]) => put(relationships).catch(onError);

  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => void save(), SAVE_AFTER_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- saves what `latest` holds once typing pauses
  }, [main, label, dirty]);
  // typing not saved yet is saved on the way out
  useEffect(() => () => { if (latest.current.dirty) void save(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (patch: { main?: string; label?: string }) => {
    edits.current++;
    if (patch.main !== undefined) { setMain(patch.main); latest.current.main = patch.main; }
    if (patch.label !== undefined) { setLabel(patch.label); latest.current.label = patch.label; }
    setDirty(true);
  };
  const reset = () => { edits.current++; setMain(''); setLabel(''); setDirty(false); };

  const addSources = (ids: string[]) => {
    setAdding(false);
    const rels = relationsOf(note?.value);
    const fresh = [...new Set(ids)].filter((s) => !rels.some((r) => r.to === s));
    if (fresh.length) void save([...rels, ...fresh.map((to) => ({ to, label: SOURCE_LABEL }))]);
  };
  const detach = async () => {
    if (!written) { reset(); return; }
    try {
      await write.put(noteValue(note?.value ?? { id, gestalt: NOTE }, main, relationsOf(note?.value).filter((r) => r.to !== concept)));
      onGone(id);
    } catch (e) { onError(e); }
  };
  const remove = async () => {
    if (!written) { reset(); return; }
    await write.remove(id);
    onGone(id);
  };

  const rels = relationsOf(note?.value);
  return (
    <section className="flex flex-col gap-2 rounded-box border border-base-300 p-3">
      <input className="input input-sm w-full" aria-label="How this relates to the concept" placeholder={LABEL} value={label}
             onChange={(e) => edit({ label: e.target.value })} />
      {main.includes('\n')
        // written elsewhere over several lines: an input would drop the line breaks on the first edit
        ? <textarea className="textarea textarea-lg w-full" aria-label="The note" rows={main.split('\n').length} value={main} onChange={(e) => edit({ main: e.target.value })} />
        : <input className="input input-lg w-full" aria-label="The note" placeholder={written ? '' : 'Something about this concept…'} value={main} onChange={(e) => edit({ main: e.target.value })} />}
      <Sources relationships={rels} concept={concept} onChange={(r) => void save(r)} />
      <div className="flex items-center gap-1">
        <button type="button" className="btn btn-ghost btn-sm" title="Add a source" onClick={() => setAdding(true)}><BookPlus className="size-4" /> Source</button>
        <span className="flex-1" />
        {dirty && <span className="text-xs text-base-content/50">…</span>}
        {(written || main || label) && <>
          <button type="button" className="btn btn-ghost btn-sm btn-square" title="Detach: the note stays, unrelated to this concept" onClick={() => void detach()}><Unlink className="size-4" /></button>
          <button type="button" className="btn btn-ghost btn-sm btn-square" title="Delete the note" onClick={() => written ? setConfirming(true) : void remove()}><Trash2 className="size-4" /></button>
        </>}
      </div>
      {adding && <AddSource attached={new Set(rels.map((r) => r.to))} onAdd={addSources} onClose={() => setAdding(false)} />}
      {confirming && (
        <ConfirmDialog title="Delete this note?" onClose={() => setConfirming(false)} onConfirm={remove}>
          This cannot be undone.
        </ConfirmDialog>
      )}
    </section>
  );
}

// ---- the concept ----

/** Every note relating to the concept, from whenever it was written, and one empty one at the end to write the next. */
function Notes({ concept, onError }: { concept: string; onError: (e: unknown) => void }) {
  const { items, hasMore, more } = useQuery({ gestalt: NOTE, refs: { to: concept, field: 'relationships' }, limit: 200 });
  // notes written here, in order, so they stay at the end; shown before the index has them too
  const [created, setCreated] = useState<string[]>([]);
  const [draft, setDraft] = useState(newId);
  const byId = new Map(items.map((n) => [n.id, n]));
  const rows: { id: string; note?: Item }[] = [
    ...items.filter((n) => !created.includes(n.id)).map((n) => ({ id: n.id, note: n })),
    ...created.map((id) => ({ id, note: byId.get(id) })),
  ];
  const last = rows.at(-1)?.note;
  const lastIsEmpty = !!last && !str(last.value.main).trim() && relationsOf(last.value).every((r) => r.to === concept);
  if (!lastIsEmpty) rows.push({ id: draft });
  const onCreated = (id: string) => {
    setCreated((c) => (c.includes(id) ? c : [...c, id]));
    if (id === draft) setDraft(newId());
  };
  const onGone = (id: string) => setCreated((c) => c.filter((x) => x !== id));

  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hasMore || !end.current) return;
    const seenEnd = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) more(); });
    seenEnd.observe(end.current);
    return () => seenEnd.disconnect();
  }, [hasMore, more, items.length]);

  return (
    <div className="flex flex-col gap-3">
      {rows.map((r) => <NoteGroup key={r.id} id={r.id} note={r.note} concept={concept} onCreated={onCreated} onGone={onGone} onError={onError} />)}
      {hasMore && <div ref={end} className="flex justify-center p-3"><span className="loading loading-spinner loading-sm" /></div>}
    </div>
  );
}

/** One alias: shown as a chip, edited in place on a click; emptied, it goes. */
function Alias({ value, onSave, onRemove }: { value: string; onSave: (v: string) => void; onRemove: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const cancelled = useRef(false);
  const done = () => {
    const next = editing ?? value;
    setEditing(null);
    if (cancelled.current) { cancelled.current = false; return; }
    if (next.trim() !== value) onSave(next);
  };
  if (editing !== null) {
    return (
      <input className="input input-xs w-40" aria-label="Alias" autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} onBlur={done}
             onKeyDown={(e) => {
               if (e.key === 'Enter') e.currentTarget.blur();
               if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur(); }
             }} />
    );
  }
  return (
    <span className="badge badge-ghost gap-0.5 pr-0.5">
      <button type="button" className="cursor-text" title="Edit the alias" onClick={() => setEditing(value)}>{value}</button>
      <button type="button" className="btn btn-ghost btn-xs btn-circle size-4 min-h-0" title="Remove the alias" onClick={onRemove}><X className="size-3" /></button>
    </span>
  );
}

/** Other names the concept goes by: edited in place, added by typing (commas or Enter separate them). */
function Aliases({ concept, onError }: { concept: Item; onError: (e: unknown) => void }) {
  const write = useWrite();
  const name = str(concept.value.name);
  const aliases = strings(concept.value.aliases);
  const [adding, setAdding] = useState('');
  /** each name once, apart from the concept's own name */
  const save = (next: string[]) => {
    const seen = new Set([fold(name)]);
    const clean = next.map((a) => a.trim()).filter((a) => a && !seen.has(fold(a)) && seen.add(fold(a)));
    const { aliases: _old, ...rest } = concept.value;
    write.put(clean.length ? { ...rest, aliases: clean } : rest).catch(onError);
  };
  const add = (text: string) => {
    const fresh = text.split(',').map((a) => a.trim()).filter(Boolean);
    setAdding('');
    if (fresh.length) save([...aliases, ...fresh]);
  };
  return (
    <div className="flex flex-wrap items-center gap-1 px-4 pb-2">
      <span className="text-xs text-base-content/60">also</span>
      {aliases.map((a, i) => (
        <Alias key={`${a}:${i}`} value={a} onSave={(v) => save(aliases.map((x, j) => (j === i ? v : x)))} onRemove={() => save(aliases.filter((_, j) => j !== i))} />
      ))}
      <input className="input input-ghost input-xs w-36" aria-label="Add an alias" placeholder="Add an alias…" value={adding}
             onChange={(e) => { if (e.target.value.endsWith(',')) add(e.target.value); else setAdding(e.target.value); }}
             onKeyDown={(e) => { if (e.key === 'Enter') add(adding); if (e.key === 'Escape') setAdding(''); }}
             onBlur={() => add(adding)} />
    </div>
  );
}

// ---- how it relates, and how well it's known ----

type LinkRow = { id: string; other: string; weight: number; kind: string; source: string };

function LinkList({ title, rows, names, onOpen }: { title: string; rows: LinkRow[]; names: Map<string, string>; onOpen: (id: string) => void }) {
  if (!rows.length) return null;
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-semibold text-base-content/60">{title}</h3>
      <ul className="flex flex-wrap gap-1">
        {rows.map((r) => (
          <li key={r.id}>
            <button type="button" className="badge badge-outline gap-1 hover:badge-primary" title={[r.kind, r.source && `claimed by ${r.source}`].filter(Boolean).join(' · ')} onClick={() => onOpen(r.other)}>
              {names.get(r.other) ?? r.other} <span className="text-base-content/50">{r.weight}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the app believes about the concept, and the concepts it says something about or is said something about by. */
function Relations({ concept, onOpen }: { concept: string; onOpen: (id: string) => void }) {
  const out = useQuery({ gestalt: LINK, refs: { to: concept, field: 'from' }, limit: 100 });
  const into = useQuery({ gestalt: LINK, refs: { to: concept, field: 'to' }, limit: 100 });
  const row = (l: Item, side: 'from' | 'to'): LinkRow => ({ id: l.id, other: str(l.value[side]), weight: Number(l.value.weight), kind: str(l.value.kind), source: str(l.value.source) });
  const outRows = out.items.map((l) => row(l, 'to'));
  const inRows = into.items.map((l) => row(l, 'from'));
  const others = [...new Set([...outRows, ...inRows].map((r) => r.other))].sort();
  const { items } = useQuery(others.length ? { gestalt: CONCEPT, ids: others, fields: ['name'], limit: others.length } : null);
  const names = new Map(items.map((c) => [c.id, str(c.value.name)]));
  const { beliefs } = useBeliefs([concept]);
  const b = beliefs.get(concept);
  return (
    <section className="flex flex-col gap-2 rounded-box border border-base-300 p-3">
      {b && (
        <p className="text-sm" title={`logit ${b.mean.toFixed(2)} ± ${b.sd.toFixed(2)}`}>
          {b.evidence || b.lastAt
            ? <>Known about <strong>{Math.round(b.p * 100)}%</strong>, from {b.evidence} answer{b.evidence === 1 ? '' : 's'} on it{b.lastAt ? `, last ${b.lastAt.slice(0, 10)}` : ''}.</>
            : <span className="text-base-content/60">Not practised yet.</span>}
        </p>
      )}
      <LinkList title="Says something about" rows={outRows} names={names} onOpen={onOpen} />
      <LinkList title="Is said something about by" rows={inRows} names={names} onOpen={onOpen} />
    </section>
  );
}

function Concept({ concept, onOpen, onClosed }: { concept: Item; onOpen: (id: string) => void; onClosed: () => void }) {
  const read = useRead();
  const write = useWrite();
  const name = str(concept.value.name);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const fail = (e: unknown) => setError(message(e));
  const cancelled = useRef(false);

  const rename = () => {
    const next = renaming?.trim();
    setRenaming(null);
    if (cancelled.current) { cancelled.current = false; return; }
    if (!next || next === name) return;
    // a name it went by as an alias is now its name, not an alias as well
    const aliases = strings(concept.value.aliases).filter((a) => fold(a) !== fold(next));
    const { aliases: _old, ...rest } = concept.value;
    write.put({ ...rest, name: next, ...(aliases.length ? { aliases } : {}) }).catch(fail);
  };
  const remove = async () => {
    const notes = await read.all({ gestalt: NOTE, refs: { to: concept.id, field: 'relationships' } });
    for (const n of notes) await write.put(noteValue(n.value, str(n.value.main), relationsOf(n.value).filter((r) => r.to !== concept.id)));
    // a link to nothing says nothing
    for (const l of await read.all({ gestalt: LINK, refs: { to: concept.id } })) await write.remove(l.id);
    await write.remove(concept.id);
    onClosed();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-base-100">
      <header className="border-b border-base-300">
        <div className="flex items-center gap-1 p-2">
          {renaming === null
            ? <h1 className="min-w-0 truncate px-2 text-xl font-semibold">{name}</h1>
            : <input className="input min-w-0 flex-1 text-xl font-semibold" aria-label="Name" autoFocus value={renaming}
                     onChange={(e) => setRenaming(e.target.value)} onBlur={rename}
                     onKeyDown={(e) => {
                       if (e.key === 'Enter') e.currentTarget.blur();
                       if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur(); }
                     }} />}
          <button type="button" className="btn btn-ghost btn-sm btn-square" title="Go to another concept" onClick={() => setSwitching(true)}><ArrowLeftRight className="size-4" /></button>
          <span className="flex-1" />
          {renaming === null && <button type="button" className="btn btn-ghost btn-sm btn-square" title="Rename" onClick={() => setRenaming(name)}><Pencil className="size-4" /></button>}
          <button type="button" className="btn btn-ghost btn-sm btn-square" title="Delete the concept" onClick={() => setConfirming(true)}><Trash2 className="size-4" /></button>
        </div>
        <Aliases concept={concept} onError={fail} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 p-3">
          {error && <div role="alert" className="alert alert-error text-sm whitespace-pre-wrap">{error}</div>}
          <Relations concept={concept.id} onOpen={onOpen} />
          <Notes concept={concept.id} onError={fail} />
        </div>
      </div>
      {switching && (
        <Modal onClose={() => setSwitching(false)}>
          <div className="p-4 pt-0"><ConceptPicker autoFocus onOpen={(id) => { setSwitching(false); onOpen(id); }} /></div>
        </Modal>
      )}
      {confirming && (
        <ConfirmDialog title={`Delete “${name}”?`} onClose={() => setConfirming(false)} onConfirm={remove}>
          Its notes will stay, no longer related to it, and its links will be deleted. This cannot be undone.
        </ConfirmDialog>
      )}
    </div>
  );
}

/** Always one concept open; without one, finding or making one. */
export default function ConceptExplorer() {
  const [concept, setConcept] = useViewState<string | null>('concept', null);
  const { items, loading } = useQuery(concept ? { gestalt: CONCEPT, ids: [concept], limit: 1 } : null);
  const item = items[0];
  if (concept && loading) return <div className="flex h-full items-center justify-center bg-base-100"><span className="loading loading-spinner" /></div>;
  if (!item) {
    return (
      <div className="flex h-full justify-center bg-base-100 p-4 pt-[15vh]">
        <div className="w-full max-w-xl"><ConceptPicker autoFocus onOpen={setConcept} /></div>
      </div>
    );
  }
  return <Concept key={item.id} concept={item} onOpen={setConcept} onClosed={() => setConcept(null)} />;
}
