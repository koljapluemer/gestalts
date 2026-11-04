import { useState, type ReactNode } from 'react';
import { Layers, LoaderCircle, Plus, Trash2, FileCode } from 'lucide-react';
import { cardId, fold, hashing, useQuery, type Card, type IndexedNote, type Part, type Repo, type Template } from '@gestalts/sdk';
import { CodeMirrorHost } from '../primitives';
import { finalCards } from './draftMerge';
import { withInline } from './noteText';

/** The old, attached form of each part, retired notes included. */
const OLD: Record<Exclude<Part, 'canvas'>, { tagsAll: string[] }> = { cards: { tagsAll: ['flashcard'] }, template: { tagsAll: ['template'] } };

type Props = { note: IndexedNote; repo: Repo };

/**
 * A note's cards and template, the parts that are keys on it. Ones still in attached notes (`card-of` flashcards, a
 * `template-of` template) are shown too, and folded into the note on the first save. A note without them offers to
 * add them.
 */
export function NoteParts({ note, repo }: Props) {
  const oldCards = useQuery(OLD.cards);
  const oldTemplates = useQuery(OLD.template);
  const [adding, setAdding] = useState<{ cards?: boolean; template?: boolean }>({});
  const cards = fold.readCards(note, fold.attached(oldCards, note.id, 'cards'), hashing);
  const template = fold.readTemplate(note, fold.attached(oldTemplates, note.id, 'template'));
  const showCards = cards.from !== 'none' || adding.cards;
  const showTemplate = template.from !== 'none' || adding.template;
  return (
    <>
      {showCards && <CardsEditor note={note} repo={repo} stored={cards.value ?? []} old={oldCards} />}
      {showTemplate && <TemplateEditor note={note} repo={repo} stored={template.value} old={oldTemplates} />}
      {(!showCards || !showTemplate) && (
        <div className="flex gap-1">
          {!showCards && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setAdding({ ...adding, cards: true })}><Layers className="size-3.5" /> Add cards</button>}
          {!showTemplate && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setAdding({ ...adding, template: true })}><FileCode className="size-3.5" /> Add a template</button>}
        </div>
      )}
    </>
  );
}

type SaveState = { saving: boolean; error?: string; conflict?: boolean };
type DraftControls = { dirty: boolean; state: SaveState; commit: (force?: boolean) => Promise<void>; discard: () => void };

/**
 * A draft of one part, saved when focus leaves its section. If the stored part changed since the draft started
 * (a sync, the YAML editor), it asks before writing over that.
 */
function usePartDraft<T>(stored: T, save: (value: T) => Promise<void>) {
  const [draft, setDraft] = useState<T | null>(null);
  const [base, setBase] = useState('');
  const [state, setState] = useState<SaveState>({ saving: false });
  const storedText = JSON.stringify(stored);
  const edit = (value: T) => {
    if (draft === null) setBase(storedText);
    setDraft(value);
  };
  const discard = () => { setDraft(null); setState({ saving: false }); };
  const commit = async (force = false) => {
    if (draft === null) return;
    if (JSON.stringify(draft) === storedText) { discard(); return; }
    if (!force && storedText !== base) { setState({ saving: false, conflict: true }); return; }
    setState({ saving: true });
    try {
      await save(draft);
      discard();
    } catch (e) {
      setState({ saving: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  return { value: draft ?? stored, dirty: draft !== null, state, edit, commit, discard };
}

function Section({ title, icon, note, repo, part, old, draft, children }: {
  title: string;
  icon: ReactNode;
  note: IndexedNote;
  repo: Repo;
  part: Exclude<Part, 'canvas'>;
  old: IndexedNote[];
  draft: DraftControls;
  children: ReactNode;
}) {
  const unwritable = fold.unwritable(note);
  const stale = fold.staleFolds(fold.folded(old, note.id, part), part, hashing);
  const resolve = async (n: IndexedNote, take: boolean) => {
    draft.discard();
    const host = repo.get(note.key);
    if (take && host) await fold.writeFold(repo, note.key, fold.foldWrites(host, part, fold.adopt(host, n, part, hashing), [], hashing));
    await repo.putValue(n.key, fold.acknowledge(n, part, hashing));
  };
  return (
    <section
      className="card card-border bg-base-100"
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) void draft.commit(); }}
    >
      <div className="card-body gap-2 p-3">
        <header className="flex items-center gap-2">
          {icon}
          <h3 className="flex-1 font-semibold">{title}</h3>
          {draft.state.saving && <LoaderCircle className="size-4 animate-spin" />}
          {draft.dirty && !draft.state.saving && <span className="badge badge-sm badge-ghost">unsaved</span>}
        </header>
        {stale.map((n) => (
          <div key={n.key} role="alert" className="alert alert-warning alert-soft py-2 text-sm">
            <span className="flex-1">The old note <code className="text-xs">{n.key}</code> was changed elsewhere after it moved into this note.</span>
            <button type="button" className="btn btn-xs" onClick={() => void resolve(n, true)}>Use that version</button>
            <button type="button" className="btn btn-xs" onClick={() => void resolve(n, false)}>Keep this one</button>
          </div>
        ))}
        {unwritable && <p className="text-sm text-warning">Read-only: {unwritable}.</p>}
        <fieldset disabled={unwritable !== null} className="flex flex-col gap-2">{children}</fieldset>
        {draft.state.conflict && draft.dirty && (
          <div role="alert" className="alert alert-warning alert-soft py-2 text-sm">
            <span className="flex-1">This changed elsewhere meanwhile. Not saved.</span>
            <button type="button" className="btn btn-xs" onClick={() => void draft.commit(true)}>Overwrite</button>
            <button type="button" className="btn btn-xs" onClick={draft.discard}>Discard my edits</button>
          </div>
        )}
        {draft.state.error && <p className="text-sm text-error">{draft.state.error}</p>}
      </div>
    </section>
  );
}

function CardsEditor({ note, repo, stored, old }: Props & { stored: Card[]; old: IndexedNote[] }) {
  const draft = usePartDraft<Card[]>(stored, async (cards) => {
    const host = repo.get(note.key);
    if (!host) throw new Error(`No note ${note.key}`);
    const attached = fold.attached(repo.query(OLD.cards), host.id, 'cards');
    const writes = fold.foldWrites(host, 'cards', finalCards(cards, cardId), attached, hashing);
    // card text may reference notes and embed blobs, like `main`
    await fold.writeFold(repo, note.key, { ...writes, host: withInline(writes.host) });
  });
  const cards = draft.value;
  const set = (i: number, patch: Partial<Card>) => draft.edit(cards.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <Section title={`Cards (${cards.length})`} icon={<Layers className="size-4" />} note={note} repo={repo} part="cards" old={old}
             draft={draft}>
      {cards.map((c, i) => (
        <div key={c.id || `new-${i}`} className="grid grid-cols-[1fr_1fr_auto] items-start gap-1">
          <textarea className="textarea textarea-sm w-full" rows={2} placeholder="Front" value={c.front} onChange={(e) => set(i, { front: e.target.value })} />
          <textarea className="textarea textarea-sm w-full" rows={2} placeholder="Back" value={c.back} onChange={(e) => set(i, { back: e.target.value })} />
          <button type="button" className="btn btn-ghost btn-xs btn-square" title="Remove this card" onClick={() => draft.edit(cards.filter((_, j) => j !== i))}>
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="btn btn-xs" onClick={() => draft.edit([...cards, { id: '', front: '', back: '' }])}><Plus className="size-3.5" /> Add a card</button>
      </div>
    </Section>
  );
}

const EMPTY_TEMPLATE: Template = { format: 'jinja-html', source: '' };

function TemplateEditor({ note, repo, stored, old }: Props & { stored: Template | undefined; old: IndexedNote[] }) {
  const draft = usePartDraft<Template>(stored ?? EMPTY_TEMPLATE, async (t) => {
    const host = repo.get(note.key);
    if (!host) throw new Error(`No note ${note.key}`);
    const attached = fold.attached(repo.query(OLD.template), host.id, 'template');
    const value = { format: t.format, source: t.source, ...(t.name?.trim() ? { name: t.name.trim() } : {}) };
    await fold.writeFold(repo, note.key, fold.foldWrites(host, 'template', value, attached, hashing));
  });
  const t = draft.value;
  const [extensions] = useState(() => []);
  return (
    <Section title="Template" icon={<FileCode className="size-4" />} note={note} repo={repo} part="template" old={old}
             draft={draft}>
      <div className="flex flex-wrap gap-2">
        <input className="input input-sm flex-1" placeholder="File name (optional)" value={t.name ?? ''} onChange={(e) => draft.edit({ ...t, name: e.target.value })} />
        <select className="select select-sm w-auto" value={t.format} onChange={(e) => draft.edit({ ...t, format: e.target.value })}>
          <option value="jinja-html">Jinja HTML</option>
        </select>
      </div>
      <CodeMirrorHost value={t.source} extensions={extensions} onChange={(source) => draft.edit({ ...draft.value, source })} onSave={() => void draft.commit()} />
    </Section>
  );
}
