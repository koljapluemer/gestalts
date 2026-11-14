import { useEffect, useRef, useState } from 'react';
import { BookOpen, BookPlus, ExternalLink, Lightbulb, StickyNote, Trash2, Unlink } from 'lucide-react';
import { useHost, useQuery, useWrite, type Item, type Json, type JsonMap } from '@gestalts/view';
import { ListInput } from '../components';
import { MarkdownEditor } from '../primitives';
import { AddSource, ItemPicker, NoteTitle, SOURCE_LABEL, byline, sourceTitle, storeFile } from '../widgets';
import { blobsOf, type BlobRef } from './NoteCard';

const NOTE = 'note@1';
const SOURCE = 'source@1';
const CONCEPT = 'concept@2';
/** a relationship's label when nothing more specific is said */
export const RELATED = 'related';

type Relationship = { to: string; label: string };
type TextProp = 'title' | 'main' | 'extra';
const TEXTS: TextProp[] = ['title', 'main', 'extra'];

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const relationsOf = (v: JsonMap): Relationship[] => (Array.isArray(v.relationships) ? (v.relationships as Relationship[]) : []);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A change to some props: a value to set, or undefined to leave it out. */
type Patch = Partial<Record<string, Json | undefined>>;

const empty = (v: Json | undefined) => v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);

/** `base` with `patch` applied: props emptied are left out (a note has only the props that have something in them). */
export function patched(base: JsonMap, patch: Patch): JsonMap {
  const next: JsonMap = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (empty(v)) delete next[k];
    else next[k] = k === 'title' && typeof v === 'string' ? v.trim() : v!;
  }
  return next;
}

/** Whether a note says anything at all: one that doesn't isn't written. */
const hasContent = (v: JsonMap) => Object.keys(v).some((k) => k !== 'id' && k !== 'gestalt');

/** The views that edit what a note relates to, by its gestalt, and the param that says which one. */
const EDITOR: Record<string, { view: string; param: string; kind: string; Icon: typeof StickyNote }> = {
  [NOTE]: { view: 'note-crud', param: 'note', kind: 'note', Icon: StickyNote },
  [CONCEPT]: { view: 'concept-explorer', param: 'concept', kind: 'concept', Icon: Lightbulb },
  [SOURCE]: { view: 'source-manager', param: 'source', kind: 'source', Icon: BookOpen },
};

/**
 * Writing one note, a change at a time, always onto the latest value: what came in from elsewhere, or what was just
 * written here (the live query may not have it yet). Writes go one after another.
 */
function useNoteWriter(id: string, note: Item | undefined, onCreated?: (id: string) => void) {
  const write = useWrite();
  const latest = useRef<JsonMap | undefined>(note?.value);
  const inFlight = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const created = useRef(onCreated);
  useEffect(() => { created.current = onCreated; });
  const [error, setError] = useState<string>();
  // what comes in is the latest, unless a write of ours is still on its way
  useEffect(() => { if (!inFlight.current) latest.current = note?.value; }, [note?.value]);
  const commit = (patch: Patch): Promise<void> => {
    inFlight.current++;
    const run = queue.current.then(async () => {
      const base = latest.current ?? { id, gestalt: NOTE };
      const next = patched(base, patch);
      if (JSON.stringify(next) === JSON.stringify(base) || (!latest.current && !hasContent(next))) return;
      const saved = await write.put(next);
      const isNew = !latest.current;
      latest.current = saved.value;
      setError(undefined);
      if (isNew) created.current?.(id);
    }).catch((e: unknown) => setError(message(e))).finally(() => { inFlight.current--; });
    queue.current = run;
    return run;
  };
  return { commit, error, setError, current: () => latest.current ?? { id, gestalt: NOTE } };
}

/** What `ids` point at, by id; undefined while still asked; missing ones point at nothing (deleted). */
function useTargets(ids: string[]): Map<string, Item> | undefined {
  const unique = [...new Set(ids)];
  const q = (gestalt: string, fields: string[]) => (unique.length ? { gestalt, ids: unique, fields, limit: unique.length } : null);
  const notes = useQuery(q(NOTE, ['title', 'main']));
  const sources = useQuery(q(SOURCE, ['title', 'key', 'author', 'editor', 'date']));
  const concepts = useQuery(q(CONCEPT, ['name']));
  if (unique.length && (notes.loading || sources.loading || concepts.loading)) return undefined;
  return new Map([...notes.items, ...sources.items, ...concepts.items].map((i) => [i.id, i]));
}

/** What a relationship points at, as one line: notes as their Markdown headline, sources with their byline. */
function TargetName({ item }: { item: Item }) {
  if (item.gestalt === SOURCE) {
    const by = byline(item.value);
    return (
      <span className="min-w-0">
        <span className="break-words">{sourceTitle(item.value)}</span>
        {by && <span className="ml-2 text-xs whitespace-nowrap text-base-content/60">{by}</span>}
      </span>
    );
  }
  if (item.gestalt === CONCEPT) return <span className="min-w-0 break-words">{str(item.value.name)}</span>;
  return <NoteTitle value={item.value} className="min-w-0 break-words" />;
}

/** A text input saved when it's left (or on Enter); changes from elsewhere show while it isn't being edited. */
function BlurInput({ value, onCommit, className, ...rest }: { value: string; onCommit: (v: string) => void; className: string; placeholder?: string; 'aria-label'?: string }) {
  // what's typed, until what's saved has caught up with it (or while it's being typed)
  const [text, setText] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [seen, setSeen] = useState(value);
  if (seen !== value) { setSeen(value); if (!editing) setText(null); }
  return (
    <input {...rest} className={className} value={text ?? value} onFocus={() => setEditing(true)} onChange={(e) => setText(e.target.value)}
           onBlur={() => { setEditing(false); if (text === null || text === value) setText(null); else onCommit(text); }}
           onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
  );
}

/** One relationship: how it relates, what to (with what it is), and opening or detaching it. */
function RelationshipRow({ r, target, known, onLabel, onDetach }: {
  r: Relationship; target?: Item; known: boolean; onLabel: (label: string) => void; onDetach: () => void;
}) {
  const { openView } = useHost();
  const editor = target ? EDITOR[target.gestalt] : undefined;
  const Icon = editor?.Icon;
  return (
    <div className="flex items-center gap-2">
      <BlurInput className="input input-sm w-36 shrink-0" aria-label="How it relates" placeholder={RELATED} value={r.label === RELATED ? '' : r.label}
                 onCommit={(l) => onLabel(l.trim() || RELATED)} />
      <span className="flex w-5 shrink-0 justify-center text-base-content/60" title={editor?.kind}>{Icon && <Icon className="size-4" />}</span>
      <span className="flex min-w-0 flex-1 items-baseline text-sm">
        {target ? <TargetName item={target} /> : <span className="text-xs text-base-content/50">{known ? '(gone) ' : ''}<code>{r.to}</code></span>}
      </span>
      {editor && (
        <button type="button" className="btn btn-ghost btn-xs btn-square" title={`Open the ${editor.kind} in a new browser tab`}
                onClick={() => void openView(editor.view, { [editor.param]: r.to }, { newTab: true })}><ExternalLink className="size-3" /></button>
      )}
      <button type="button" className="btn btn-ghost btn-xs btn-square" title="Detach: both stay, unrelated" onClick={onDetach}><Unlink className="size-3" /></button>
    </div>
  );
}

/** A note's relationships: each to something named, with a label (`related` when left empty). */
function Relationships({ self, value, onChange }: { self: string; value: Relationship[]; onChange: (r: Relationship[]) => void }) {
  const targets = useTargets(value.map((r) => r.to));
  const [adding, setAdding] = useState(false);
  const linked = new Set(value.map((r) => r.to));
  const add = (ids: string[], label: string) => {
    const fresh = [...new Set(ids)].filter((id) => !linked.has(id));
    if (fresh.length) onChange([...value, ...fresh.map((to) => ({ to, label }))]);
  };
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">Relationships</h3>
      {value.map((r, i) => (
        <RelationshipRow key={`${r.to}:${i}`} r={r} target={targets?.get(r.to)} known={!!targets}
                         onLabel={(label) => onChange(value.map((x, j) => (j === i ? { ...x, label } : x)))}
                         onDetach={() => onChange(value.filter((_, j) => j !== i))} />
      ))}
      <div className="flex items-start gap-2">
        <LinkSearch exclude={new Set([...linked, self])} onPick={(id) => add([id], RELATED)} />
        <button type="button" className="btn btn-ghost btn-sm" title="Add a source" onClick={() => setAdding(true)}><BookPlus className="size-4" /> Source</button>
      </div>
      {adding && <AddSource attached={linked} onAdd={(ids) => { setAdding(false); add(ids, SOURCE_LABEL); }} onClose={() => setAdding(false)} />}
    </section>
  );
}

/** Finding a note or a concept to relate to; `exclude` aren't offered. */
function LinkSearch({ exclude, onPick }: { exclude: Set<string>; onPick: (id: string) => void }) {
  return (
    <ItemPicker
      placeholder="Link a note or concept…" exclude={exclude} onPick={(i) => onPick(i.id)}
      // concepts first: there are few, and a name typed in full is most likely meant
      query={(text) => ({ gestalt: CONCEPT, text, fields: ['name'], limit: 4 })}
      more={(text) => ({ gestalt: NOTE, text, fields: ['title', 'main'], limit: 6 })}
      render={(i) => {
        const E = EDITOR[i.gestalt];
        return <span className="flex min-w-0 items-baseline gap-2">{E && <E.Icon className="size-4 shrink-0 self-center text-base-content/60" />}<TargetName item={i} /></span>;
      }}
    />
  );
}

/** The files a note carries, each with a label. */
function Files({ blobs, onChange, onError }: { blobs: BlobRef[]; onChange: (b: BlobRef[]) => void; onError: (e: string) => void }) {
  const write = useWrite();
  const attach = async (files: FileList | null) => {
    const added: BlobRef[] = [];
    for (const f of Array.from(files ?? [])) {
      try {
        const b = await storeFile(write, f);
        if (!blobs.some((x) => x.file === b.file) && !added.some((x) => x.file === b.file)) added.push(b);
      } catch (e) { onError(message(e)); }
    }
    if (added.length) onChange([...blobs, ...added]);
  };
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold">Files</h3>
      {blobs.map((b, i) => (
        <div key={b.file} className="flex items-center gap-2">
          <BlurInput className="input input-xs w-32" aria-label="Label" value={b.label} onCommit={(label) => onChange(blobs.map((x, j) => (j === i ? { ...x, label } : x)))} />
          <code className="min-w-0 flex-1 truncate text-xs">{b.file}</code>
          <button type="button" className="btn btn-ghost btn-xs btn-square" title="Remove" onClick={() => onChange(blobs.filter((_, j) => j !== i))}><Trash2 className="size-3" /></button>
        </div>
      ))}
      <input type="file" multiple className="file-input file-input-sm w-full" onChange={(e) => { void attach(e.target.files); e.target.value = ''; }} />
    </section>
  );
}

/**
 * Edits every prop of the note `id`, always: each text is saved when it's left, everything else as it changes; what
 * isn't saved yet is saved when the editor goes. A note that isn't there yet is written once it has something in it,
 * then `onCreated` is told. It reads `note@1`, `source@1` and `concept@2` (what a note relates to) and writes `note@1`
 * and `source@1` (sources pasted in as BibTeX).
 */
export function NoteEditor({ id, onCreated, autoFocus }: { id: string; onCreated?: (id: string) => void; autoFocus?: boolean }) {
  const { items, loading } = useQuery({ gestalt: NOTE, ids: [id], limit: 1 });
  if (loading && !items.length) return <div className="flex justify-center p-6"><span className="loading loading-spinner loading-sm" /></div>;
  // a new note starts at its title
  return <Fields id={id} note={items[0]} onCreated={onCreated} autoFocus={autoFocus && !items[0]} />;
}

function Fields({ id, note, onCreated, autoFocus }: { id: string; note?: Item; onCreated?: (id: string) => void; autoFocus?: boolean }) {
  const { commit, error, setError } = useNoteWriter(id, note, onCreated);
  const saved: JsonMap = note?.value ?? {};
  const [texts, setTexts] = useState<Record<TextProp, string>>(() => ({ title: str(saved.title), main: str(saved.main), extra: str(saved.extra) }));
  // typed here and not saved yet: what's saved elsewhere doesn't replace it
  const [dirty, setDirty] = useState<ReadonlySet<TextProp>>(() => new Set());
  // what saving and leaving need, current in callbacks that outlive a render
  const latest = useRef({ texts, dirty });
  useEffect(() => { latest.current = { texts, dirty }; });
  // the saved texts changed: those not being typed follow them
  const savedKey = JSON.stringify(TEXTS.map((p) => str(saved[p])));
  const [seen, setSeen] = useState(savedKey);
  if (seen !== savedKey) {
    setSeen(savedKey);
    setTexts((t) => ({ ...t, ...Object.fromEntries(TEXTS.filter((p) => !dirty.has(p)).map((p) => [p, str(saved[p])])) }));
  }

  const type = (p: TextProp, v: string) => {
    setDirty((d) => (d.has(p) ? d : new Set([...d, p])));
    setTexts((t) => ({ ...t, [p]: v }));
  };
  const leave = (p: TextProp) => {
    if (!latest.current.dirty.has(p)) return;
    const v = latest.current.texts[p];
    void commit({ [p]: v }).then(() => {
      if (latest.current.texts[p] === v) setDirty((d) => new Set([...d].filter((x) => x !== p)));
    });
  };
  // what's typed is saved on the way out too
  useEffect(() => () => {
    const patch: Patch = {};
    for (const p of latest.current.dirty) patch[p] = latest.current.texts[p];
    if (Object.keys(patch).length) void commit(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on unmount
  }, []);

  const set = (patch: Patch) => void commit(patch);
  return (
    <div className="flex flex-col gap-3 p-3">
      {error && <div role="alert" className="alert alert-error text-sm whitespace-pre-wrap">{error}</div>}
      <input className="input w-full" placeholder="Title" value={texts.title} autoFocus={autoFocus} onChange={(e) => type('title', e.target.value)}
             onBlur={() => leave('title')} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
      <MarkdownEditor value={texts.main} onChange={(v: string) => type('main', v)} onBlur={() => leave('main')} onSave={() => leave('main')} placeholder="Main" />
      <MarkdownEditor value={texts.extra} onChange={(v: string) => type('extra', v)} onBlur={() => leave('extra')} onSave={() => leave('extra')} placeholder="Extra" minHeight="3rem" />
      <ListInput label="Alias" prefix="aliases" value={strings(saved.aliases)} onChange={(aliases) => set({ aliases })} />
      <ListInput label="Tag" prefix="tags" value={strings(saved.tags)} onChange={(tags) => set({ tags })} />
      <Relationships self={id} value={relationsOf(saved)} onChange={(relationships) => set({ relationships })} />
      <Files blobs={blobsOf(saved)} onChange={(blobs) => set({ blobs })} onError={setError} />
    </div>
  );
}
