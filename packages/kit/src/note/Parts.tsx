import { useState, type ReactNode } from 'react';
import { FileCode, Layers, Plus, Trash2 } from 'lucide-react';
import { fold, hashing, useQuery, type Card, type IndexedNote, type Json, type JsonMap, type Repo, type Template } from '@gestalts/sdk';
import { CodeMirrorHost } from '../primitives';

/** The old, attached form of each part, retired notes included. */
const OLD: Record<'cards' | 'template', { tagsAll: string[] }> = { cards: { tagsAll: [fold.ATTACHED_TAG.cards] }, template: { tagsAll: [fold.ATTACHED_TAG.template] } };

/** A note's cards and template: the note's own keys, else those still in attached notes (folded in on the next save). */
export function useParts(note: IndexedNote | undefined, value: JsonMap) {
  const oldCards = useQuery(OLD.cards);
  const oldTemplates = useQuery(OLD.template);
  const host: IndexedNote | undefined = note && { ...note, value };
  const cards = host ? fold.readCards(host, fold.attached(oldCards, host.id, 'cards'), hashing) : { value: undefined, from: 'none' as const };
  const template = host ? fold.readTemplate(host, fold.attached(oldTemplates, host.id, 'template')) : { value: undefined, from: 'none' as const };
  const stale = (part: 'cards' | 'template', old: IndexedNote[]) => (host ? fold.staleFolds(fold.folded(old, host.id, part), part, hashing) : []);
  return {
    cards: value.cards !== undefined ? toCards(value.cards) : cards.value,
    template: value.template !== undefined ? toTemplate(value.template) : template.value,
    stale: [...stale('cards', oldCards).map((n) => ({ n, part: 'cards' as const })), ...stale('template', oldTemplates).map((n) => ({ n, part: 'template' as const }))],
  };
}

const str = (v: Json | undefined) => (typeof v === 'string' ? v : '');
function toCards(v: Json): Card[] {
  return (Array.isArray(v) ? v : []).flatMap((c) => (c && typeof c === 'object' && !Array.isArray(c) ? [{ id: str(c.id), front: str(c.front), back: str(c.back) }] : []));
}
function toTemplate(v: Json): Template | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  return { format: str(v.format) || 'jinja-html', source: str(v.source), ...(typeof v.name === 'string' ? { name: v.name } : {}) };
}

type EditProps = { edit: (patch: Record<string, Json | undefined>) => void; onSave: () => void };

/** The cards and template edited, each offered when the note has none. */
export function PartsEditor({ cards, template, edit, onSave }: EditProps & { cards: Card[] | undefined; template: Template | undefined }) {
  const [adding, setAdding] = useState<{ cards?: boolean; template?: boolean }>({});
  const showCards = cards !== undefined || adding.cards;
  const showTemplate = template !== undefined || adding.template;
  return (
    <>
      {showCards && <CardsEditor cards={cards ?? []} edit={edit} />}
      {showTemplate && <TemplateEditor template={template ?? { format: 'jinja-html', source: '' }} edit={edit} onSave={onSave} />}
      {(!showCards || !showTemplate) && (
        <div className="flex gap-1">
          {!showCards && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setAdding({ ...adding, cards: true })}><Layers className="size-3.5" /> Cards</button>}
          {!showTemplate && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setAdding({ ...adding, template: true })}><FileCode className="size-3.5" /> Template</button>}
        </div>
      )}
    </>
  );
}

function Part({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-box border border-base-300 p-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold">{icon} {title}</h3>
      {children}
    </section>
  );
}

function CardsEditor({ cards, edit }: { cards: Card[]; edit: EditProps['edit'] }) {
  const set = (next: Card[]) => edit({ cards: next.map((c) => ({ ...(c.id ? { id: c.id } : {}), front: c.front, back: c.back })) });
  const at = (i: number, patch: Partial<Card>) => set(cards.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <Part title={`Cards (${cards.length})`} icon={<Layers className="size-4" />}>
      {cards.map((c, i) => (
        <div key={c.id || `new-${i}`} className="grid grid-cols-[1fr_1fr_auto] items-start gap-1">
          <textarea className="textarea textarea-sm w-full" rows={2} placeholder="Front" value={c.front} onChange={(e) => at(i, { front: e.target.value })} />
          <textarea className="textarea textarea-sm w-full" rows={2} placeholder="Back" value={c.back} onChange={(e) => at(i, { back: e.target.value })} />
          <button type="button" className="btn btn-ghost btn-xs btn-square" title="Remove this card" onClick={() => set(cards.filter((_, j) => j !== i))}>
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
      <div><button type="button" className="btn btn-xs" onClick={() => set([...cards, { id: '', front: '', back: '' }])}><Plus className="size-3.5" /> Add a card</button></div>
    </Part>
  );
}

function TemplateEditor({ template: t, edit, onSave }: EditProps & { template: Template }) {
  const [extensions] = useState(() => []);
  const set = (next: Template) => edit({ template: { format: next.format, source: next.source, ...(next.name?.trim() ? { name: next.name.trim() } : {}) } });
  return (
    <Part title="Template" icon={<FileCode className="size-4" />}>
      <div className="flex flex-wrap gap-2">
        <input className="input input-sm flex-1" placeholder="File name (optional)" value={t.name ?? ''} onChange={(e) => set({ ...t, name: e.target.value })} />
        <select className="select select-sm w-auto" value={t.format} onChange={(e) => set({ ...t, format: e.target.value })}>
          <option value="jinja-html">Jinja HTML</option>
        </select>
      </div>
      <CodeMirrorHost value={t.source} extensions={extensions} onChange={(source) => set({ ...t, source })} onSave={onSave} />
    </Part>
  );
}

/** An old attached note changed elsewhere after it was folded into this one: take that version, or keep this one. */
export function StaleFolds({ stale, noteKey, repo, onResolved }: {
  stale: { n: IndexedNote; part: 'cards' | 'template' }[];
  noteKey: string;
  repo: Repo;
  onResolved: () => void;
}) {
  if (!stale.length) return null;
  const resolve = async (n: IndexedNote, part: 'cards' | 'template', take: boolean) => {
    const host = repo.get(noteKey);
    if (take && host) await fold.writeFold(repo, noteKey, fold.foldWrites(host, part, fold.adopt(host, n, part, hashing), [], hashing));
    await repo.putValue(n.key, fold.acknowledge(n, part, hashing));
    onResolved();
  };
  return (
    <>
      {stale.map(({ n, part }) => (
        <div key={n.key} role="alert" className="alert alert-warning alert-soft py-2 text-sm">
          <span className="flex-1">The old note <code className="text-xs">{n.key}</code> was changed elsewhere after its {part === 'cards' ? 'card' : 'template'} moved into this note.</span>
          <button type="button" className="btn btn-xs" onClick={() => void resolve(n, part, true)}>Use that version</button>
          <button type="button" className="btn btn-xs" onClick={() => void resolve(n, part, false)}>Keep this one</button>
        </div>
      ))}
    </>
  );
}
