import { useState } from 'react';
import { ClipboardPaste } from 'lucide-react';
import { bibOf, match, mergeSource, normalise, parseBibtex, titleWords, type Bib, type Candidate } from '@gestalts/sources';
import { useDoc, useQuery, useRead, useWrite, type JsonMap, type Query } from '@gestalts/view';
import { Modal } from '../components';
import { useDebounced } from '../primitives';

/** Bibliographic sources (`source@1`) for any view: BibTeX pasted in without duplicates, and finding one. */

const SOURCE = 'source@1';
/** how a note relates to a source it draws on, unless it says more (a locator: `source p. 34`) */
export const SOURCE_LABEL = 'source';

type Read = ReturnType<typeof useRead>;
type Write = ReturnType<typeof useWrite>;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** "Hofstadter 1979", for telling sources apart in lists. */
export function byline(v: Record<string, unknown>): string {
  const first = strings(v.author)[0] ?? strings(v.editor)[0] ?? '';
  const family = first.includes(',') ? first.split(',')[0] : first;
  return [family, str(v.date).slice(0, 4)].filter(Boolean).join(' ');
}

export const sourceTitle = (v: Record<string, unknown>) => str(v.title) || str(v.key) || '(untitled)';

/** A `Bib` as yml props: without the fields it doesn't have. */
export const bibJson = (b: Bib): JsonMap => Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) as JsonMap;

/** A key no other source has: `key`, else `key-2`, `key-3`, … */
export async function freeKey(read: Read, key: string, self?: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? key : `${key}-${n}`;
    const { items } = await read.page({ gestalt: SOURCE, where: { key: candidate }, fields: [], limit: 2 });
    if (!items.some((i) => i.id !== self)) return candidate;
  }
}

/**
 * The existing sources a pasted one may be, without loading them all: those sharing an identifier, and those found by
 * the title's rarest-looking words, judged by `match`.
 */
export async function sourceCandidates(read: Read, bib: Bib): Promise<Candidate<Bib & { id: string }>[]> {
  const queries: Query[] = [];
  for (const f of ['doi', 'isbn', 'eprint'] as const) if (typeof bib[f] === 'string') queries.push({ gestalt: SOURCE, where: { [f]: bib[f] }, limit: 5 });
  for (const w of titleWords(bib.title ?? '', 3)) queries.push({ gestalt: SOURCE, text: w, limit: 20 });
  const pages = await Promise.all(queries.map((q) => read.page(q)));
  const seen = new Map<string, Bib & { id: string }>();
  for (const i of pages.flatMap((p) => p.items)) seen.set(i.id, { id: i.id, ...bibOf(i.value) });
  return match(bib, [...seen.values()]);
}

export async function clipboardText(): Promise<string> {
  try { return await navigator.clipboard.readText(); } catch { throw new Error("The clipboard can't be read here: press Ctrl+V instead."); }
}

export type Ingested = {
  /** false when an entry couldn't be used */
  ok: boolean;
  /** what happened, one sentence per entry */
  said: string[];
  /** every source added or found already here, in the order of the entries */
  ids: string[];
  /** the source to show: the last one with differences to decide (`incoming`), else the last one */
  show?: { id: string; incoming?: Bib };
};

const quoted = (b: { title?: string; key: string }) => `'${b.title ?? b.key}'`;

/**
 * BibTeX straight into the sources: each entry that is (likely) one already here fills in that one's missing fields,
 * every other entry becomes a new source. Differences to an existing one are left to decide.
 */
export async function ingestBibtex(read: Read, write: Write, text: string): Promise<Ingested> {
  const said: string[] = [];
  const ids: string[] = [];
  let ok = true;
  let show: Ingested['show'];
  const entries = parseBibtex(text);
  if (!entries.length) return { ok: false, said: ['No BibTeX entry found.'], ids };
  for (const raw of entries) {
    let bib: Bib;
    try { bib = normalise({ ...raw }); } catch (e) { ok = false; said.push(`${raw.key}: ${message(e)}`); continue; }
    const found = await sourceCandidates(read, bib);
    const same = found.find((c) => c.level !== 'possible');
    if (same) {
      const item = (await read.page({ gestalt: SOURCE, ids: [same.source.id], limit: 1 })).items[0];
      const r = mergeSource(bibOf(item.value), bib, []);
      if (r.filled.length) await write.put({ ...item.value, ...bibJson(r.value) });
      said.push(`${quoted(r.value)} was here${r.filled.length ? `: filled ${r.filled.join(', ')}` : ''}${r.conflicts.length ? `; ${r.conflicts.length} to decide` : ''}.`);
      ids.push(item.id);
      if (r.conflicts.length) show = { id: item.id, incoming: bib };
      else if (!show?.incoming) show = { id: item.id };
    } else {
      const key = await freeKey(read, bib.key);
      const saved = await write.put({ gestalt: SOURCE, ...bibJson({ ...bib, key }) });
      said.push(`Added ${quoted(bib)}${found[0] ? ` (maybe the same as ${quoted(found[0].source)})` : ''}.`);
      ids.push(saved.id);
      if (!show?.incoming) show = { id: saved.id };
    }
  }
  return { ok, said, ids, show };
}


/** A box to paste BibTeX into (or take it from the clipboard): each entry becomes a source, or finds the one here. */
export function BibtexPaste({ onIngested }: { onIngested: (r: Ingested) => void }) {
  const read = useRead();
  const write = useWrite();
  const [text, setText] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);
  const run = async (bibtex: string) => {
    setBusy(true);
    setStatus(undefined);
    try {
      const r = await ingestBibtex(read, write, bibtex);
      setStatus({ ok: r.ok, text: r.said.join(' ') });
      if (r.ids.length) { setText(''); onIngested(r); }
    } catch (e) { setStatus({ ok: false, text: message(e) }); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-2">
      <textarea className="textarea textarea-sm w-full font-mono" rows={4} placeholder="Paste BibTeX: @article{…}" value={text}
                onChange={(e) => setText(e.target.value)}
                onPaste={(e) => { const t = e.clipboardData.getData('text/plain'); if (t.includes('@')) { e.preventDefault(); void run(t); } }} />
      <div className="flex items-center gap-2">
        <button type="button" className="btn btn-sm" disabled={busy} title="Add the BibTeX in the clipboard"
                onClick={() => void clipboardText().then(run, (e: unknown) => setStatus({ ok: false, text: message(e) }))}>
          {busy ? <span className="loading loading-spinner loading-xs" /> : <ClipboardPaste className="size-4" />} From clipboard
        </button>
        <span className="flex-1" />
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || !text.trim()} onClick={() => void run(text)}>Add</button>
      </div>
      {status && <p role={status.ok ? 'status' : 'alert'} className={`text-sm break-words ${status.ok ? 'text-base-content/70' : 'text-error'}`}>{status.text}</p>}
    </div>
  );
}

/** Finding a source by its title, authors, key or aliases. */
export function SourceSearch({ exclude, onPick, placeholder = 'Find a source…' }: { exclude?: Set<string>; onPick: (id: string) => void; placeholder?: string }) {
  const [search, setSearch] = useState('');
  const text = useDebounced(search, 150).trim();
  const { items, loading } = useQuery(text ? { gestalt: SOURCE, text, limit: 8, fields: ['title', 'key', 'author', 'editor', 'date'] } : null);
  const found = items.filter((s) => !exclude?.has(s.id));
  return (
    <div className="flex flex-col gap-1">
      <input className="input input-sm w-full" type="search" placeholder={placeholder} value={search} onChange={(e) => setSearch(e.target.value)} />
      {found.map((s) => (
        <button key={s.id} type="button" className="btn btn-ghost btn-sm h-auto justify-start py-1 text-left font-normal" onClick={() => { onPick(s.id); setSearch(''); }}>
          <span className="min-w-0 flex-1">
            <span className="block truncate">{sourceTitle(s.value)}</span>
            <span className="block truncate text-xs text-base-content/60">{[byline(s.value), str(s.value.key)].filter(Boolean).join(' · ')}</span>
          </span>
        </button>
      ))}
      {text && !loading && !found.length && <p className="px-2 text-sm text-base-content/60">Nothing found.</p>}
    </div>
  );
}

/**
 * Picking sources for something to draw on, in a modal: one you have, or new ones from pasted BibTeX. `attached` are
 * left out of the search; `onAdd` gets the ids picked.
 */
export function AddSource({ attached, onAdd, onClose }: { attached: Set<string>; onAdd: (ids: string[]) => void; onClose: () => void }) {
  return (
    <Modal onClose={onClose}>
      <div className="flex flex-col gap-4 p-4 pt-0">
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">A source you have</h3>
          <SourceSearch exclude={attached} onPick={(id) => onAdd([id])} />
        </section>
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">A new one, from BibTeX</h3>
          <BibtexPaste onIngested={(r) => onAdd(r.ids)} />
        </section>
      </div>
    </Modal>
  );
}

/** An SPDX id as people write it: `CC-BY-SA-4.0` is "CC BY-SA 4.0"; anything else as it is. */
export function licenseLabel(spdx: string): string {
  const cc = /^CC-([A-Z-]+?)-(\d+\.\d+)$/.exec(spdx);
  return cc ? `CC ${cc[1]} ${cc[2]}` : spdx;
}

type Credit = { to: string; label: string };
const creditsOf = (v: unknown): Credit[] => (Array.isArray(v) ? v.filter((c): c is Credit => !!c && typeof c === 'object' && typeof (c as Credit).to === 'string') : []);

function CreditLine({ credit }: { credit: Credit }) {
  const source = useDoc(SOURCE, credit.to);
  if (!source) return null;
  const v = source.value;
  const how = credit.label ? credit.label[0].toUpperCase() + credit.label.slice(1) : 'From';
  const by = strings(v.organization)[0] || byline(v);
  const url = str(v.url);
  const title = <cite>{sourceTitle(v)}</cite>;
  return (
    <span className="block">
      {how} {url ? <a href={url} target="_blank" rel="noreferrer" className="link">{title}</a> : title}
      {by && `, ${by}`}{str(v.license) && `, ${licenseLabel(str(v.license))}`}
    </span>
  );
}

/**
 * Where a yml comes from, from its `sources` (`[{to: source id, label}]`): "Adapted from *Vietnamese phrasebook*,
 * Wikivoyage, CC BY-SA 4.0". The view needs to read `source@1`. Nothing when there are none.
 */
export function Credits({ sources, className = '' }: { sources: unknown; className?: string }) {
  const list = creditsOf(sources);
  if (!list.length) return null;
  return <small className={`text-xs opacity-70 ${className}`}>{list.map((c) => <CreditLine key={c.to + c.label} credit={c} />)}</small>;
}
