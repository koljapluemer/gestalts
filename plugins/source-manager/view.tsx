import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ClipboardPaste, Download, Pencil, Plus, Trash2, Unlink, X } from 'lucide-react';
import {
  ConceptPicker, ConfirmDialog, ListInput, MarkdownEditor, Modal, NoteCard, NoteEditor, NotePicker, bibJson, byline, clipboardText, freeKey, ingestBibtex, sourceTitle as titleOf,
} from '@gestalts/kit';
import {
  ENTRY_TYPES, FIELD_NAMES, FIELDS, bibOf, isEntryType, mergeSource, normalise, parseBibtex, renderBibtex, slug,
  type Bib, type EntryType, type FieldName, type MergeConflict,
} from '@gestalts/sources';
import { useCapabilities, useDoc, useHost, useParams, useQuery, useRead, useService, useViewState, useWrite, type Item, type JsonMap } from '@gestalts/view';

const SOURCE = 'source@1';
const NOTE = 'note@1';
const CONCEPT = 'concept@2';
/** how strongly a concept comes up in a source when it's first attached */
const STRENGTH = 0.5;
const PAGE = 40;
const DEFAULT_LABEL = 'source';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const many = (f: FieldName) => FIELDS[f] === 'name' || FIELDS[f] === 'list';

function useDebounced(value: string, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

// ---- the form ----

type Draft = {
  key: string; entrytype: EntryType; title: string;
  /** names and lists one per line */
  fields: Partial<Record<FieldName, string>>;
  /** fields shown beyond the type's defaults and those that have a value */
  added: FieldName[];
  aliases: string[]; tags: string[]; extra: string;
};

function fieldText(v: unknown): string {
  if (Array.isArray(v)) return v.join('\n');
  return v === undefined || v === null ? '' : String(v);
}

function draftOf(v: Record<string, unknown>, keep?: Draft): Draft {
  const b = bibOf(v);
  return {
    key: b.key, entrytype: b.entrytype, title: b.title ?? '',
    fields: Object.fromEntries(FIELD_NAMES.filter((f) => b[f] !== undefined).map((f) => [f, fieldText(b[f])])),
    added: keep?.added ?? [],
    aliases: keep ? keep.aliases : strings(v.aliases),
    tags: keep ? keep.tags : strings(v.tags),
    extra: keep ? keep.extra : str(v.extra),
  };
}

/** The draft's bibliographic part, checked. Throws, saying what's wrong. */
function bibOfDraft(d: Draft): Bib {
  const raw: Record<string, unknown> = { key: d.key.trim() || slug(d.title).slice(0, 40), entrytype: d.entrytype, title: d.title };
  for (const [f, text] of Object.entries(d.fields) as [FieldName, string][]) {
    raw[f] = many(f) ? text.split('\n').map((x) => x.trim()).filter(Boolean) : text;
  }
  return normalise(raw);
}

/** What the form saves: its fields, and what it doesn't edit (`blobs`, `concepts`) as `live` has it now. */
function sourceValue(id: string | undefined, bib: Bib, d: Draft, live: JsonMap | undefined): JsonMap {
  const { aliases, tags } = d;
  const blobs = live?.blobs;
  const concepts = live?.concepts;
  return {
    ...(id ? { id } : {}),
    gestalt: SOURCE,
    ...bibJson(bib),
    ...(aliases.length ? { aliases } : {}),
    ...(tags.length ? { tags } : {}),
    ...(d.extra.trim() ? { extra: d.extra } : {}),
    ...(Array.isArray(blobs) && blobs.length ? { blobs: blobs as JsonMap[] } : {}),
    ...(concepts && typeof concepts === 'object' && !Array.isArray(concepts) && Object.keys(concepts).length ? { concepts } : {}),
  };
}

const shown = (d: Draft): FieldName[] => {
  const want = new Set<FieldName>([...ENTRY_TYPES[d.entrytype], ...d.added, ...(Object.keys(d.fields) as FieldName[])]);
  return FIELD_NAMES.filter((f) => want.has(f));
};

const HINT: Partial<Record<string, string>> = {
  name: 'One per line: family, given', list: 'One per line', date: '2020, 2020-05 or 2020-05-17', range: '12--34',
};

function FieldInput({ field, value, onChange }: { field: FieldName; value: string; onChange: (v: string) => void }) {
  const type = FIELDS[field];
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-semibold text-base-content/70">{field}</span>
      {many(field)
        ? <textarea className="textarea textarea-sm w-full" rows={Math.max(2, value.split('\n').length)} placeholder={HINT[type]} value={value} onChange={(e) => onChange(e.target.value)} />
        : <input className="input input-sm w-full" inputMode={type === 'integer' ? 'numeric' : undefined} placeholder={HINT[type]} value={value} onChange={(e) => onChange(e.target.value)} />}
    </label>
  );
}

/** Pasting BibTeX over a source: what it adds at once, and the differences to decide. */
function Repaste({ conflicts, take, onTake, onApply, onCancel }: {
  conflicts: MergeConflict[]; take: string[]; onTake: (field: string, on: boolean) => void; onApply: () => void; onCancel: () => void;
}) {
  const show = (v: unknown) => (Array.isArray(v) ? v.join('; ') : String(v));
  return (
    <section className="flex flex-col gap-2 rounded-box border border-warning p-3">
      <h3 className="text-sm font-semibold">The pasted BibTeX differs here: take its value?</h3>
      {conflicts.map((c) => (
        <label key={c.field} className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="checkbox checkbox-sm mt-0.5" checked={take.includes(c.field)} onChange={(e) => onTake(c.field, e.target.checked)} />
          <span className="min-w-0 flex-1">
            <span className="font-semibold">{c.field}</span>
            <span className="block break-words text-base-content/60 line-through">{show(c.current)}</span>
            <span className="block break-words">{show(c.incoming)}</span>
          </span>
        </label>
      ))}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>Keep all mine</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={onApply}>Apply</button>
      </div>
    </section>
  );
}

// ---- claims: notes relating to the source ----

type Relationship = { to: string; label: string };
const relationsOf = (n: Item): Relationship[] => (Array.isArray(n.value.relationships) ? (n.value.relationships as Relationship[]) : []);

function withRelations(n: Item, relationships: Relationship[]): JsonMap {
  const { relationships: _old, ...rest } = n.value;
  return relationships.length ? { ...rest, relationships } : rest;
}

/** A claim this source makes: a note relating to it, labelled `source`. */
function NewClaim({ source, onError }: { source: string; onError: (e: unknown) => void }) {
  const write = useWrite();
  const [main, setMain] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      await write.put({ gestalt: NOTE, main, relationships: [{ to: source, label: DEFAULT_LABEL }] });
      setMain('');
    } catch (e) { onError(e); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-2 rounded-box border border-base-300 p-2">
      <MarkdownEditor value={main} onChange={setMain} placeholder="A claim this source makes" minHeight="3rem" onSave={() => { if (main.trim()) void add(); }} />
      <div className="flex justify-end">
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || !main.trim()} onClick={() => void add()}><Plus className="size-4" /> Add claim</button>
      </div>
    </div>
  );
}

function Claims({ source }: { source: string }) {
  const read = useRead();
  const write = useWrite();
  const { items, hasMore, more } = useQuery({ gestalt: NOTE, refs: { to: source, field: 'relationships' }, limit: 100 });
  const [editing, setEditing] = useState<string>();
  const [error, setError] = useState<string>();
  const fail = (e: unknown) => setError(message(e));
  const detach = (n: Item, index: number) => write.put(withRelations(n, relationsOf(n).filter((_, j) => j !== index))).catch(fail);
  /** the note as it is now (what the search shows is only some of its props), related to the source too */
  const attach = async (picked: Item) => {
    try {
      const n = (await read.page({ gestalt: NOTE, ids: [picked.id], limit: 1 })).items[0];
      if (n && !relationsOf(n).some((r) => r.to === source)) await write.put(withRelations(n, [...relationsOf(n), { to: source, label: DEFAULT_LABEL }]));
    } catch (e) { fail(e); }
  };
  const rows = items.flatMap((n) => relationsOf(n).flatMap((r, i) => (r.to === source ? [{ n, r, i }] : [])));
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">Claims</h3>
      {error && <div role="alert" className="alert alert-error text-sm">{error}</div>}
      {rows.map(({ n, r, i }) => (
        <div key={`${n.id}:${i}`} className="flex flex-col gap-2 rounded-box border border-base-300 p-2">
          <NoteCard value={n.value} />
          <div className="flex items-center gap-1">
            {r.label !== DEFAULT_LABEL && <span className="text-xs text-base-content/60">{r.label}</span>}
            <span className="flex-1" />
            <button type="button" className="btn btn-ghost btn-xs" title="Edit the note" onClick={() => setEditing(n.id)}><Pencil className="size-3" /></button>
            <button type="button" className="btn btn-ghost btn-xs" title="Detach: the note stays, unrelated to this source" onClick={() => void detach(n, i)}><Unlink className="size-3" /></button>
          </div>
        </div>
      ))}
      {hasMore && <button type="button" className="btn btn-ghost btn-sm" onClick={more}>More</button>}
      <NewClaim source={source} onError={fail} />
      <NotePicker unrelatedTo={source} placeholder="Attach an existing note…" onPick={(n) => void attach(n)} />
      {editing && <Modal onClose={() => setEditing(undefined)}><NoteEditor key={editing} id={editing} /></Modal>}
    </section>
  );
}

// ---- concepts: what the source is about, and how strongly ----

/** `concepts` of a source: concept id → how strongly it comes up there, 0..1. */
function conceptsOf(v: JsonMap): Record<string, number> {
  const c = v.concepts;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return {};
  return Object.fromEntries(Object.entries(c).filter((e): e is [string, number] => typeof e[1] === 'number'));
}

/** How strongly a concept comes up: a slider, saved once it's let go. */
function Strength({ value, onSave }: { value: number; onSave: (v: number) => void }) {
  // where it's been moved to, until what's saved has caught up with it (or while it's held)
  const [moved, setMoved] = useState<number | null>(null);
  const [held, setHeld] = useState(false);
  const [seen, setSeen] = useState(value);
  if (seen !== value) { setSeen(value); if (!held) setMoved(null); }
  const v = moved ?? value;
  const done = () => { setHeld(false); if (moved === null || moved === value) setMoved(null); else onSave(moved); };
  return (
    <label className="flex shrink-0 items-center gap-2" title="How strongly it comes up in this source">
      <input type="range" className="range range-xs w-28" min={0} max={1} step={0.1} value={v} aria-label="How strongly it comes up"
             onPointerDown={() => setHeld(true)} onChange={(e) => setMoved(Number(e.target.value))}
             onPointerUp={done} onKeyUp={done} onBlur={() => { if (held || moved !== null) done(); }} />
      <span className="w-8 text-right text-xs tabular-nums text-base-content/60">{v.toFixed(1)}</span>
    </label>
  );
}

/** The concepts this source is about, each with how strongly; found, or made, by name. */
function Concepts({ source }: { source: Item }) {
  const read = useRead();
  const write = useWrite();
  const { openView } = useHost();
  const [error, setError] = useState<string>();
  const map = conceptsOf(source.value);
  const ids = Object.keys(map);
  const { items } = useQuery(ids.length ? { gestalt: CONCEPT, ids, fields: ['name'], limit: ids.length } : null);
  const names = new Map(items.map((c) => [c.id, str(c.value.name)]));
  /** the source as it is now, with its concepts changed by `f` */
  const change = async (f: (m: Record<string, number>) => Record<string, number>) => {
    setError(undefined);
    try {
      const now = (await read.page({ gestalt: SOURCE, ids: [source.id], limit: 1 })).items[0];
      if (!now) throw new Error('That source is gone.');
      const next = f(conceptsOf(now.value));
      const { concepts: _old, ...rest } = now.value;
      await write.put(Object.keys(next).length ? { ...rest, concepts: next } : rest);
    } catch (e) { setError(message(e)); }
  };
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">Concepts</h3>
      {error && <div role="alert" className="alert alert-error text-sm">{error}</div>}
      {ids.map((id) => (
        <div key={id} className="flex items-center gap-2">
          <button type="button" className="link link-hover min-w-0 flex-1 text-left text-sm break-words" title="Open in the concept explorer"
                  onClick={() => void openView('concept-explorer', { concept: id })}>
            {names.get(id) ?? <code className="text-xs text-base-content/50">{id}</code>}
          </button>
          <Strength value={map[id]} onSave={(v) => void change((m) => ({ ...m, [id]: v }))} />
          <button type="button" className="btn btn-ghost btn-xs btn-square" title="Remove the concept from this source"
                  onClick={() => void change((m) => { const { [id]: _gone, ...rest } = m; return rest; })}><X className="size-3" /></button>
        </div>
      ))}
      <ConceptPicker exclude={new Set(ids)} placeholder="Add a concept it's about…" onPick={(id) => void change((m) => (id in m ? m : { ...m, [id]: STRENGTH }))} />
    </section>
  );
}

// ---- one source ----

type Pending = { incoming: Bib; conflicts: MergeConflict[]; take: string[] };

/** `draft` with `incoming` merged in: missing fields filled, the rest as `take` says. */
function mergeInto(draft: Draft, incoming: Bib, take: string[]) {
  const r = mergeSource(bibOfDraft(draft), incoming, take);
  return { draft: draftOf(r.value, draft), filled: r.filled, conflicts: r.conflicts };
}

/** Every prop of a source; `source` absent makes a new one. `incoming`: BibTeX to merge in at once. */
function Editor({ source, incoming, onBack, onSaved, onDeleted }: {
  source?: Item; incoming?: Bib; onBack: () => void; onSaved: (saved: Item) => void; onDeleted: () => void;
}) {
  const write = useWrite();
  const read = useRead();
  const [start] = useState(() => {
    const draft = draftOf(source?.value ?? { entrytype: 'misc' });
    if (!incoming) return { draft };
    try {
      const m = mergeInto(draft, incoming, []);
      return { draft: m.draft, notice: m.filled.length ? `Filled ${m.filled.join(', ')}.` : undefined, pending: m.conflicts.length ? { incoming, conflicts: m.conflicts, take: m.conflicts.map((c) => c.field).filter((f) => f !== 'key') } : undefined };
    } catch (e) { return { draft, error: message(e) }; }
  });
  const [draft, setDraft] = useState<Draft>(start.draft);
  const [pending, setPending] = useState<Pending | undefined>(start.pending);
  const [notice, setNotice] = useState<string | undefined>(start.notice);
  const [error, setError] = useState<string | undefined>(start.error);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState('');
  const [confirming, setConfirming] = useState(false);
  const set = (patch: Partial<Draft>) => { setNotice(undefined); setDraft((d) => ({ ...d, ...patch })); };
  const setField = (f: FieldName, v: string) => set({ fields: { ...draft.fields, [f]: v } });
  const fail = (e: unknown) => setError(message(e));

  const save = async (d: Draft = draft) => {
    setBusy(true);
    setError(undefined);
    try {
      const bib = bibOfDraft(d);
      const key = await freeKey(read, bib.key, source?.id);
      if (key !== bib.key && source) throw new Error(`Another source has the key '${bib.key}'.`);
      const saved = await write.put(sourceValue(source?.id, { ...bib, key }, d, source?.value));
      setDraft((d) => ({ ...d, key }));
      setNotice((n) => (key !== bib.key ? `Saved, as '${key}': '${bib.key}' was taken.` : n ?? 'Saved.'));
      onSaved(saved);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!source) return;
    await write.remove(source.id);
    onDeleted();
  };

  /** The clipboard's BibTeX merged in: what's missing is filled and saved at once; differences wait for a decision. */
  const merge = (text: string) => {
    setError(undefined);
    try {
      const entries = parseBibtex(text);
      if (entries.length !== 1) throw new Error(`Expected one BibTeX entry, found ${entries.length}.`);
      const incomingBib = normalise({ ...entries[0] });
      const m = mergeInto(draft, incomingBib, []);
      setDraft(m.draft);
      setNotice(m.filled.length ? `Filled ${m.filled.join(', ')}.` : m.conflicts.length ? undefined : 'Nothing new in the BibTeX.');
      setPending(m.conflicts.length ? { incoming: incomingBib, conflicts: m.conflicts, take: m.conflicts.map((c) => c.field).filter((f) => f !== 'key') } : undefined);
      if (m.filled.length) void save(m.draft);
    } catch (e) { fail(e); }
  };

  const apply = () => {
    if (!pending) return;
    try {
      const next = mergeInto(draft, pending.incoming, pending.take).draft;
      setDraft(next);
      setPending(undefined);
      void save(next);
    } catch (e) { fail(e); }
  };

  const fields = shown(draft);
  const more = FIELD_NAMES.filter((f) => !fields.includes(f));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-base-300 p-2">
        <button type="button" className="btn btn-sm btn-ghost md:hidden" title="Back to the list" onClick={onBack}><ArrowLeft className="size-4" /></button>
        <button type="button" className="btn btn-sm btn-ghost" title="Update this source from the BibTeX in the clipboard" onClick={() => void clipboardText().then(merge, fail)}><ClipboardPaste className="size-4" /> BibTeX</button>
        <span className="flex-1" />
        {notice && <span className="truncate text-sm text-base-content/60">{notice}</span>}
        {source && <button type="button" className="btn btn-sm btn-ghost" title="Delete" onClick={() => setConfirming(true)}><Trash2 className="size-4" /></button>}
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void save()}>Save</button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {error && <div role="alert" className="alert alert-error text-sm whitespace-pre-wrap">{error}</div>}
        {pending && (
          <Repaste conflicts={pending.conflicts} take={pending.take} onApply={apply} onCancel={() => setPending(undefined)}
                   onTake={(f, on) => setPending({ ...pending, take: on ? [...pending.take, f] : pending.take.filter((x) => x !== f) })} />
        )}

        <input className="input w-full" placeholder="Title" value={draft.title} onChange={(e) => set({ title: e.target.value })} />
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-base-content/70">key</span>
            <input className="input input-sm w-full font-mono" placeholder={slug(draft.title).slice(0, 40) || 'doe2020'} value={draft.key} onChange={(e) => set({ key: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-base-content/70">type</span>
            <select className="select select-sm w-full" value={draft.entrytype} onChange={(e) => { if (isEntryType(e.target.value)) set({ entrytype: e.target.value }); }}>
              {Object.keys(ENTRY_TYPES).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          {fields.map((f) => <FieldInput key={f} field={f} value={draft.fields[f] ?? ''} onChange={(v) => setField(f, v)} />)}
        </div>
        {more.length > 0 && (
          <select className="select select-sm w-full md:w-60" aria-label="Add a field" value={adding} onChange={(e) => { const f = e.target.value as FieldName; setAdding(''); if (f) set({ added: [...draft.added, f] }); }}>
            <option value="">Add a field…</option>
            {more.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        )}
        <ListInput label="Alias" prefix="aliases" placeholder="Another way you'd look for it…" value={draft.aliases} onChange={(aliases) => set({ aliases })} />
        <ListInput label="Tag" prefix="tags" value={draft.tags} onChange={(tags) => set({ tags })} />
        <MarkdownEditor value={draft.extra} onChange={(extra: string) => set({ extra })} placeholder="Extra" minHeight="3rem" />
        {source ? <><Concepts source={source} /><Claims source={source.id} /></> : <p className="text-sm text-base-content/60">Save the source to add concepts and claims about it.</p>}
      </div>
      {confirming && (
        <ConfirmDialog title="Delete this source?" onClose={() => setConfirming(false)} onConfirm={remove}>
          Notes about it will stay, pointing at nothing. This cannot be undone.
        </ConfirmDialog>
      )}
    </div>
  );
}

function Existing({ id, incoming, onBack, onDeleted }: { id: string; incoming?: Bib; onBack: () => void; onDeleted: () => void }) {
  const source = useDoc(SOURCE, id);
  return source ? <Editor source={source} incoming={incoming} onBack={onBack} onSaved={() => {}} onDeleted={onDeleted} /> : null;
}

// ---- the list ----

function Export() {
  const read = useRead();
  const service = useService();
  const [path, setPath] = useViewState<string>('exportPath', '~/sources.bib');
  const [status, setStatus] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setStatus(undefined);
    try {
      const items = await read.all({ gestalt: SOURCE });
      const r = await service<{ path: string; written: boolean }>('/export', { path, text: renderBibtex(items.map((i) => bibOf(i.value))) });
      setStatus({ ok: true, text: `${items.length} sources ${r.written ? 'written to' : 'unchanged in'} ${r.path}` });
    } catch (e) { setStatus({ ok: false, text: message(e) }); } finally { setBusy(false); }
  };
  return (
    <details className="border-t border-base-300 p-2">
      <summary className="cursor-pointer text-sm"><Download className="inline size-4" /> Export .bib</summary>
      <div className="mt-2 flex gap-2">
        <input className="input input-sm min-w-0 flex-1 font-mono" aria-label="Where to write the .bib" value={path} onChange={(e) => setPath(e.target.value)} />
        <button type="button" className="btn btn-sm" disabled={busy || !path.trim()} onClick={() => void run()}>Write</button>
      </div>
      {status && <p className={`mt-1 text-xs break-words ${status.ok ? 'text-base-content/60' : 'text-error'}`}>{status.text}</p>}
    </details>
  );
}

type Status = { ok: boolean; text: string };

function List({ selected, status, busy, onSelect, onNew, onPaste }: {
  selected: string | null; status?: Status; busy: boolean; onSelect: (id: string) => void; onNew: () => void; onPaste: () => void;
}) {
  const [search, setSearch] = useViewState<string>('search', '');
  const text = useDebounced(search, 150);
  const { capabilities } = useCapabilities();
  const { items, loading, hasMore, more } = useQuery({ gestalt: SOURCE, ...(text.trim() ? { text } : {}), limit: PAGE, fields: ['title', 'key', 'author', 'editor', 'date'] });
  const end = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!hasMore || !end.current) return;
    const seen = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) more(); });
    seen.observe(end.current);
    return () => seen.disconnect();
  }, [hasMore, more, items.length]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex gap-2 border-b border-base-300 p-2">
        <input className="input input-sm min-w-0 flex-1" type="search" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button type="button" className="btn btn-sm btn-square" title="Add the BibTeX in the clipboard (or press Ctrl+V)" disabled={busy} onClick={onPaste}>
          {busy ? <span className="loading loading-spinner loading-xs" /> : <ClipboardPaste className="size-4" />}
        </button>
        <button type="button" className="btn btn-sm btn-primary btn-square" title="New source" onClick={onNew}><Plus className="size-4" /></button>
      </div>
      {status && <p role={status.ok ? 'status' : 'alert'} className={`border-b border-base-300 px-3 py-2 text-sm break-words ${status.ok ? 'text-base-content/70' : 'text-error'}`}>{status.text}</p>}
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {items.map((s) => (
          <li key={s.id}>
            <button type="button" className={`w-full px-3 py-2 text-left hover:bg-base-200 ${s.id === selected ? 'bg-base-300' : ''}`} onClick={() => onSelect(s.id)}>
              <span className="block truncate">{titleOf(s.value)}</span>
              <span className="block truncate text-xs text-base-content/60">{[byline(s.value), str(s.value.key)].filter(Boolean).join(' · ')}</span>
            </button>
          </li>
        ))}
        {hasMore && <li ref={end} className="flex justify-center p-3"><span className="loading loading-spinner loading-sm" /></li>}
        {!loading && !items.length && <li className="p-6 text-center text-base-content/60">{text.trim() ? 'Nothing found.' : 'No sources yet.'}</li>}
      </ul>
      {capabilities?.backend && <Export />}
    </div>
  );
}

type Pane = { kind: 'none' } | { kind: 'new' } | { kind: 'source'; id: string; incoming?: Bib; n: number };

/**
 * BibTeX straight into the sources: each entry that is (likely) one already here fills in that one's missing fields,
 * every other entry becomes a new source. Says what it did; differences to decide open with that source.
 */
function useIngest(open: (id: string, incoming?: Bib) => void) {
  const read = useRead();
  const write = useWrite();
  const [status, setStatus] = useState<Status>();
  const [busy, setBusy] = useState(false);
  const ingest = async (text: string) => {
    setBusy(true);
    setStatus(undefined);
    try {
      const r = await ingestBibtex(read, write, text);
      setStatus({ ok: r.ok, text: r.said.join(' ') });
      if (r.show) open(r.show.id, r.show.incoming);
    } catch (e) { setStatus({ ok: false, text: message(e) }); } finally { setBusy(false); }
  };
  return { ingest, status, busy, fail: (e: unknown) => setStatus({ ok: false, text: message(e) }) };
}

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

/** On a phone, the list or one pane; on anything wider, side by side. */
export default function SourceManager() {
  const [params, setParams] = useParams();
  const selected = params.source ?? null;
  const setSelected = (id: string | null) => setParams(id ? { source: id } : {});
  const [pane, setPane] = useState<Pane>(() => (selected ? { kind: 'source', id: selected, n: 0 } : { kind: 'none' }));
  const open = (id: string, incoming?: Bib) => { setSelected(id); setPane((p) => ({ kind: 'source', id, incoming, n: (p.kind === 'source' ? p.n : 0) + 1 })); };
  const close = () => { setSelected(null); setPane({ kind: 'none' }); };
  // moved to a source from elsewhere (another view, a link): that one shows
  useEffect(() => {
    if (selected && !(pane.kind === 'source' && pane.id === selected)) setPane((p) => ({ kind: 'source', id: selected, n: (p.kind === 'source' ? p.n : 0) + 1 }));
    if (!selected && pane.kind === 'source') setPane({ kind: 'none' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the param only
  }, [selected]);
  const { ingest, status, busy, fail } = useIngest(open);
  const fromClipboard = () => void clipboardText().then(ingest, fail);
  // Ctrl+V anywhere but in a field adds what's pasted
  const latest = useRef(ingest);
  useEffect(() => { latest.current = ingest; });
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (typing(e.target) || !text.includes('@')) return;
      e.preventDefault();
      void latest.current(text);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);
  const showPane = pane.kind !== 'none';
  return (
    <div className="flex h-full bg-base-100">
      <div className={`h-full w-full border-base-300 md:w-80 md:shrink-0 md:border-r ${showPane ? 'hidden md:block' : ''}`}>
        <List selected={pane.kind === 'source' ? pane.id : null} status={status} busy={busy} onSelect={(id) => open(id)} onNew={() => { setSelected(null); setPane({ kind: 'new' }); }} onPaste={fromClipboard} />
      </div>
      <div className={`h-full min-w-0 flex-1 ${showPane ? '' : 'hidden md:block'}`}>
        {pane.kind === 'new' && <Editor onBack={close} onSaved={(s) => open(s.id)} onDeleted={close} />}
        {pane.kind === 'source' && <Existing key={`${pane.id}:${pane.n}`} id={pane.id} incoming={pane.incoming} onBack={close} onDeleted={close} />}
      </div>
    </div>
  );
}
