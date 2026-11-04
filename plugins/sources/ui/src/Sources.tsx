import { useMemo, useState } from 'react';
import { ClipboardPaste, Copy, Download, FileCode2, Plus, Search, Upload } from 'lucide-react';
import { bib, noteLabel, relationships, str, useNote, type IndexedNote, type Json, type Query, type Repo, type SourceMatch, definePerspective } from '@gestalts/sdk';
import { EditableNote, filterSources, saveRawSynced, sourceSummary } from '@gestalts/kit';
import { asSource, citekeyFor, duplicateCitekeys, fieldText, fieldValue, model, withField } from './sourceModel';

type Props = {
  /** key of the source shown */
  open?: string;
  onSelect: (key: string) => void;
  /** another note was asked to be opened (one citing the source); without it they're listed, not linked */
  onOpen?: (key: string) => void;
};

/**
 * Bibliographic sources (`source@1`): a filterable list, a form for the one open, BibTeX import that recognises
 * sources already there, updating one from BibTeX, and the whole list as a `.bib` download.
 */
export const Sources = definePerspective<{ sources: Query; all: Query }, Props>({
  id: 'sources',
  title: 'Sources',
  data: { sources: { tagsAll: ['source'] }, all: {} },
  Component: ({ data, repo, open, onSelect, onOpen }) => {
    const [filter, setFilter] = useState('');
    const [importing, setImporting] = useState(false);
    const duplicates = useMemo(() => duplicateCitekeys(data.sources), [data.sources]);
    const shown = useMemo(() => filterSources(data.sources, filter), [data.sources, filter]);

    const create = async () => {
      const title = filter.trim() || 'New source';
      const taken = data.sources.flatMap((s) => str(s, 'citekey') ?? []);
      const made = await repo.putValue(undefined, { title, citekey: bib.uniqueCitekey(citekeyFor(title), taken), entrytype: 'misc', tags: ['source'] });
      setFilter('');
      onSelect(made.key);
    };
    const exportBib = () => {
      const text = bib.write(data.sources.map(asSource));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/x-bibtex' }));
      a.download = 'sources.bib';
      a.click();
      URL.revokeObjectURL(a.href);
    };

    return (
      <div className="grid h-full min-h-0 grid-cols-1 gap-3 p-3 md:grid-cols-[20rem_minmax(0,1fr)]">
        <aside className={`flex min-h-0 flex-col gap-2 ${open ? 'max-md:hidden' : ''}`}>
          <div className="flex gap-1">
            <label className="input input-sm flex-1">
              <Search className="size-4 opacity-50" />
              <input type="search" placeholder="Filter, or a new source's title" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </label>
            <button type="button" className="btn btn-sm btn-square btn-primary" title="New source (from the filter's text)" onClick={() => void create()}><Plus className="size-4" /></button>
          </div>
          <div className="flex gap-1">
            <button type="button" className={`btn btn-xs ${importing ? 'btn-active' : ''}`} onClick={() => setImporting(!importing)}><Upload className="size-3.5" /> Import BibTeX</button>
            <button type="button" className="btn btn-xs" onClick={exportBib} disabled={!data.sources.length}><Download className="size-3.5" /> sources.bib</button>
          </div>
          {importing && <BibtexImport repo={repo} sources={data.sources} onDone={(keys) => { setImporting(false); if (keys.length === 1) onSelect(keys[0]); }} />}
          <p className="text-xs text-base-content/50">{shown.length} of {data.sources.length} sources</p>
          <ul className="menu menu-sm min-h-0 w-full flex-1 flex-nowrap overflow-y-auto p-0">
            {shown.map((s) => (
              <li key={s.key}>
                <button type="button" className={`block text-left ${s.key === open ? 'menu-active' : ''}`} onClick={() => onSelect(s.key)}>
                  <span className="font-mono text-xs">{str(s, 'citekey') ?? '—'}</span>
                  {duplicates.has(str(s, 'citekey') ?? '') && <span className="badge badge-xs badge-warning ml-1">duplicate key</span>}
                  {s.lints.length > 0 && <span className="badge badge-xs badge-ghost ml-1">{s.lints.length} issue{s.lints.length > 1 ? 's' : ''}</span>}
                  <span className="block truncate opacity-70">{sourceSummary(s) || noteLabel(s)}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <section className={`min-h-0 overflow-y-auto ${open ? '' : 'max-md:hidden'}`}>
          {open
            ? <SourceDetail key={open} repo={repo} sourceKey={open} all={data.all} duplicate={duplicates} onOpen={onOpen} onBack={() => onSelect('')} />
            : <p className="p-8 text-center text-base-content/60">Pick a source, add one, or import BibTeX.</p>}
        </section>
      </div>
    );
  },
});

function BibtexImport({ repo, sources, onDone }: { repo: Repo; sources: IndexedNote[]; onDone: (keys: string[]) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    try { return bib.parse(text); } catch (e) { return e instanceof Error ? e.message : String(e); }
  }, [text]);
  const existing = useMemo(() => sources.map((s) => ({ key: s.key, source: asSource(s) })), [sources]);
  const matches = useMemo(() => (Array.isArray(parsed) ? parsed.map((p) => bib.matches(p.source, existing)) : []), [parsed, existing]);
  // per entry: '' for a new source, else the key of the existing one it is
  const [choice, setChoice] = useState<Record<number, string>>({});
  const chosen = (i: number) => choice[i] ?? (matches[i]?.[0] && matches[i][0].level !== 'possible' ? matches[i][0].key : '');

  const apply = async () => {
    if (!Array.isArray(parsed)) return;
    setBusy(true);
    setError(null);
    try {
      const keys: string[] = [];
      const taken = sources.flatMap((s) => str(s, 'citekey') ?? []);
      for (const [i, { source }] of parsed.entries()) {
        const into = chosen(i);
        if (into) {
          const current = repo.get(into);
          const merged = bib.merge(current ? asSource(current) : {}, source);
          if (merged.filled.length) await repo.putValue(into, merged.source);
          keys.push(into);
        } else {
          const citekey = bib.uniqueCitekey(String(source.citekey ?? 'source'), taken);
          taken.push(citekey);
          keys.push((await repo.putValue(undefined, { ...source, citekey, tags: ['source'] })).key);
        }
      }
      setText('');
      onDone(keys);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <div className="flex flex-col gap-2 rounded-box border border-base-300 p-2">
      <div className="flex gap-1">
        <button type="button" className="btn btn-xs" onClick={() => void navigator.clipboard.readText().then(setText, (e: unknown) => setError(String(e)))}>
          <ClipboardPaste className="size-3.5" /> Paste
        </button>
        <label className="btn btn-xs"><FileCode2 className="size-3.5" /> .bib file
          <input type="file" accept=".bib,text/plain" className="hidden" onChange={(e) => { void e.target.files?.[0]?.text().then(setText); }} />
        </label>
      </div>
      <textarea className="textarea textarea-sm h-24 w-full font-mono text-xs" placeholder="@article{key, title={…}, …}" value={text} onChange={(e) => { setText(e.target.value); setChoice({}); }} />
      {typeof parsed === 'string' && <p className="text-xs text-error">{parsed}</p>}
      {Array.isArray(parsed) && parsed.map((p, i) => (
        <div key={i} className="text-xs">
          <p className="font-semibold">{String(p.source.title ?? p.source.citekey)}</p>
          {p.warnings.map((w) => <p key={w} className="text-warning">{w}</p>)}
          <select className="select select-xs mt-1 w-full" value={chosen(i)} onChange={(e) => setChoice({ ...choice, [i]: e.target.value })}>
            <option value="">new source</option>
            {matches[i].map((m: SourceMatch) => (
              <option key={m.key} value={m.key}>{m.level}: {labelOf(repo, m.key)} ({m.reasons.join(', ')})</option>
            ))}
          </select>
        </div>
      ))}
      {error && <p className="text-xs text-error">{error}</p>}
      <button type="button" className="btn btn-sm btn-primary" disabled={!Array.isArray(parsed) || busy} onClick={() => void apply()}>
        Import {Array.isArray(parsed) ? parsed.length : ''}
      </button>
    </div>
  );
}

const labelOf = (repo: Repo, key: string) => { const n = repo.get(key); return n ? `${str(n, 'citekey') ?? ''} ${noteLabel(n)}` : key; };

function SourceDetail({ repo, sourceKey, all, duplicate, onOpen, onBack }: {
  repo: Repo; sourceKey: string; all: IndexedNote[]; duplicate: Set<string>; onOpen?: (key: string) => void; onBack: () => void;
}) {
  const note = useNote(sourceKey);
  const [raw, setRaw] = useState(false);
  const [updating, setUpdating] = useState(false);
  // fields added to the form, shown until filled in (an empty field isn't stored)
  const [added, setAdded] = useState<string[]>([]);
  const { entryTypes, fields } = useMemo(() => model(), []);
  if (!note) return <p className="p-8 text-center text-base-content/60">No source <code>{sourceKey}</code>.</p>;
  const kinds = new Map(fields);
  const entrytype = str(note, 'entrytype') ?? 'misc';
  const shownFields = [...new Set([...(entryTypes.find(([t]) => t === entrytype)?.[1] ?? []), ...fields.map(([f]) => f).filter((f) => asSource(note)[f] !== undefined || added.includes(f))])];
  const addable = fields.map(([f]) => f).filter((f) => !shownFields.includes(f));
  const set = (field: string, next: Json | undefined) => void repo.putValue(note.key, withField(repo.get(note.key)?.value ?? null, field, next));
  const citekey = str(note, 'citekey') ?? '';
  const citedBy = all.filter((n) => relationships(n).some((r) => r.label === 'cites' && r.target === note.id));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-xs md:hidden" onClick={onBack}>← Sources</button>
        <span className="font-mono">{citekey}</span>
        <button type="button" className="btn btn-ghost btn-xs btn-square" title="Copy the citekey" onClick={() => void navigator.clipboard.writeText(citekey)}><Copy className="size-3.5" /></button>
        {duplicate.has(citekey) && <span className="badge badge-sm badge-warning">another source has this key</span>}
        <div className="flex-1" />
        <button type="button" className={`btn btn-xs ${updating ? 'btn-active' : ''}`} onClick={() => setUpdating(!updating)}>Update from BibTeX</button>
        <button type="button" className={`btn btn-xs ${raw ? 'btn-active' : ''}`} onClick={() => setRaw(!raw)}>YAML</button>
      </div>
      {updating && <BibtexUpdate repo={repo} note={note} onDone={() => setUpdating(false)} />}
      {raw ? (
        <EditableNote note={note} inspect={(text) => repo.inspect(note.key, text)} save={(text) => saveRawSynced(repo, note.key, text)} />
      ) : (
        <div className="grid grid-cols-[8rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2 text-sm">
          <FieldRow label="title" value={str(note, 'title') ?? ''} onCommit={(t) => set('title', fieldValue(t, 'literal'))} />
          <FieldRow label="citekey" value={citekey} onCommit={(t) => set('citekey', fieldValue(t, 'literal'))} mono />
          <span className="pt-1 text-base-content/60">entrytype</span>
          <select className="select select-sm" value={entrytype} onChange={(e) => set('entrytype', e.target.value)}>
            {entryTypes.map(([t]) => <option key={t}>{t}</option>)}
          </select>
          {shownFields.map((f) => (
            <FieldRow key={f} label={f} value={fieldText(asSource(note)[f], kinds.get(f))} multiline={kinds.get(f) === 'names' || kinds.get(f) === 'list'}
                      mono={kinds.get(f) === 'verbatim'} onCommit={(t) => set(f, fieldValue(t, kinds.get(f)))} />
          ))}
          {addable.length > 0 && <>
            <span />
            <select className="select select-xs w-48" value="" onChange={(e) => { if (e.target.value) setAdded([...added, e.target.value]); }}>
              <option value="">add a field…</option>
              {addable.map((f) => <option key={f}>{f}</option>)}
            </select>
          </>}
          <FieldRow label="notes" value={str(note, 'main') ?? ''} multiline onCommit={(t) => set('main', fieldValue(t, 'literal'))} />
        </div>
      )}
      {note.lints.length > 0 && (
        <ul className="text-xs text-warning">{note.lints.map((l, i) => <li key={i}>{l.path}: {l.message}</li>)}</ul>
      )}
      {citedBy.length > 0 && (
        <div className="text-sm">
          <p className="text-base-content/60">Cited by</p>
          <ul className="menu menu-sm p-0">
            {citedBy.map((n) => <li key={n.key}>{onOpen ? <button type="button" onClick={() => onOpen(n.key)}>{noteLabel(n)}</button> : <span>{noteLabel(n)}</span>}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

/** One field, written when focus leaves it. */
function FieldRow({ label, value, onCommit, multiline, mono }: { label: string; value: string; onCommit: (text: string) => void; multiline?: boolean; mono?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => { if (draft !== null && draft !== value) onCommit(draft); setDraft(null); };
  const cls = `w-full ${mono ? 'font-mono' : ''}`;
  return (
    <>
      <span className="pt-1 text-base-content/60">{label}</span>
      {multiline
        ? <textarea className={`textarea textarea-sm min-h-16 ${cls}`} value={draft ?? value} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />
        : <input className={`input input-sm ${cls}`} value={draft ?? value} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
                 onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />}
    </>
  );
}

/** One BibTeX entry merged into the source: missing fields filled in, differing ones taken where ticked. */
function BibtexUpdate({ repo, note, onDone }: { repo: Repo; note: IndexedNote; onDone: () => void }) {
  const [text, setText] = useState('');
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const entry = useMemo(() => {
    if (!text.trim()) return null;
    try { return bib.parse(text)[0].source; } catch (e) { return e instanceof Error ? e.message : String(e); }
  }, [text]);
  const preview = entry && typeof entry !== 'string' ? bib.merge(asSource(note), entry) : null;
  const apply = async () => {
    if (!entry || typeof entry === 'string' || !preview) return;
    const take = preview.conflicts.map((c) => c.field).filter((f) => !skip.has(f));
    await repo.putValue(note.key, bib.merge(asSource(note), entry, take).source);
    onDone();
  };
  return (
    <div className="flex flex-col gap-2 rounded-box border border-base-300 p-2 text-sm">
      <div className="flex gap-1">
        <button type="button" className="btn btn-xs" onClick={() => void navigator.clipboard.readText().then(setText)}><ClipboardPaste className="size-3.5" /> Paste</button>
      </div>
      <textarea className="textarea textarea-sm h-20 w-full font-mono text-xs" placeholder="one BibTeX entry" value={text} onChange={(e) => setText(e.target.value)} />
      {typeof entry === 'string' && <p className="text-xs text-error">{entry}</p>}
      {preview && <>
        {preview.filled.length > 0 && <p className="text-xs">Fills in: {preview.filled.join(', ')}</p>}
        {preview.conflicts.map((c) => (
          <label key={c.field} className="flex items-start gap-2 text-xs">
            <input type="checkbox" className="checkbox checkbox-xs" checked={!skip.has(c.field)}
                   onChange={() => { const next = new Set(skip); if (next.has(c.field)) next.delete(c.field); else next.add(c.field); setSkip(next); }} />
            <span><b>{c.field}</b>: {JSON.stringify(c.current)} → {JSON.stringify(c.incoming)}</span>
          </label>
        ))}
        <button type="button" className="btn btn-sm btn-primary" disabled={!preview.filled.length && !preview.conflicts.length} onClick={() => void apply()}>Apply</button>
      </>}
    </div>
  );
}
