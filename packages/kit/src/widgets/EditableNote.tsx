import { useState } from 'react';
import { LoaderCircle, Trash2, X } from 'lucide-react';
import { noteLabel, useRepo, type IndexedNote } from '@gestalts/sdk';
import { GestaltBadges, YamlEditor } from '../components';
import { draftSave } from './draftMerge';

type Props = {
  note: IndexedNote;
  inspect: (raw: string) => IndexedNote;
  save: (raw: string) => Promise<unknown>;
  onClose?: () => void;
  onDelete?: () => void;
  autofocus?: boolean;
  /** without its own card and header (label, key, close, delete): the owner shows those */
  bare?: boolean;
};

/**
 * One note as raw YAML. Saves when focus leaves it and on Mod-s.
 * While there are no unsaved edits it follows the note (e.g. after a sync). If the note changed while a draft was
 * open (a canvas or cards save, a sync), saving merges the draft in as a sync does; if both changed the same value,
 * it asks before writing over the other change.
 */
export function EditableNote({ note, inspect, save, onClose, onDelete, autofocus, bare = false }: Props) {
  // null: no unsaved edits, show the stored text
  const repo = useRepo();
  const [draft, setDraft] = useState<string | null>(null);
  // the note's text when the draft started
  const [base, setBase] = useState<string | null>(null);
  const [state, setState] = useState<{ saving: boolean; error?: string; conflict?: boolean }>({ saving: false });
  const text = draft ?? note.raw;
  const live = draft === null ? note : inspect(draft);

  const write = async (raw: string) => {
    setState({ saving: true });
    try {
      await save(raw);
      setDraft(null);
      setBase(null);
      setState({ saving: false });
    } catch (e) {
      setState({ saving: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const discard = () => { setDraft(null); setBase(null); setState({ saving: false }); };
  const commit = async () => {
    if (draft === null || draft === note.raw) { discard(); return; }
    const plan = draftSave(base ?? note.raw, draft, note.raw, (b, l, r) => repo.merge3(note.key, b, l, r));
    if (plan.kind === 'conflict') { setState({ saving: false, conflict: true }); return; }
    await write(plan.text);
  };

  const status = (
    <>
      {state.saving && <LoaderCircle className="size-4 animate-spin" />}
      {draft !== null && !state.saving && <span className="badge badge-sm badge-ghost">unsaved</span>}
    </>
  );
  return (
    <section
      className={bare ? '' : 'card card-border bg-base-100'}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) void commit(); }}
    >
      <div className={bare ? 'flex flex-col gap-2' : 'card-body gap-2 p-3'}>
        {bare ? <div className="flex min-h-5 justify-end gap-2 empty:hidden">{status}</div> : <header className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-semibold">{noteLabel(live)}</h2>
            <p className="truncate font-mono text-xs text-base-content/50">{note.key}</p>
          </div>
          {status}
          {onDelete && (
            <button type="button" className="btn btn-ghost btn-xs btn-square" title="Delete note" onClick={onDelete}>
              <Trash2 className="size-4" />
            </button>
          )}
          {onClose && (
            <button type="button" className="btn btn-ghost btn-xs btn-square" title="Close" onClick={() => { void commit(); onClose(); }}>
              <X className="size-4" />
            </button>
          )}
        </header>}
        <GestaltBadges gestalts={live.gestalts} lints={live.lints} />
        <YamlEditor value={text} inspect={inspect} onChange={(t) => { if (draft === null) setBase(note.raw); setDraft(t); }} onSave={() => void commit()} autofocus={autofocus} />
        {state.conflict && draft !== null && (
          <div role="alert" className="alert alert-warning alert-soft py-2 text-sm">
            <span className="flex-1">This note was changed elsewhere meanwhile, in the same place as your edit. Not saved.</span>
            <button type="button" className="btn btn-xs" onClick={() => void write(draft)}>Overwrite</button>
            <button type="button" className="btn btn-xs" onClick={discard}>Discard my edits</button>
          </div>
        )}
        {state.error && <p className="text-sm text-error">{state.error}</p>}
      </div>
    </section>
  );
}
