import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useRepo, type IndexedNote } from '@gestalts/sdk';
import { YamlEditor } from '../components';
import { draftSave } from '../widgets/draftMerge';
import { saveRawSynced } from '../widgets/noteText';

/**
 * The whole note as YAML, with its parse errors and gestalt lints inline: the way to what the fields don't show.
 * Saves when focus leaves it and on Mod-s. While unedited it follows the note; a draft is merged into a note that
 * changed meanwhile as a sync merges, and when both changed the same value it asks before writing over the other.
 */
export function SourceEditor({ note, autofocus, onSaved }: { note: IndexedNote; autofocus?: boolean; onSaved?: () => void }) {
  const repo = useRepo();
  const [draft, setDraft] = useState<string | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [state, setState] = useState<{ saving: boolean; error?: string; conflict?: boolean }>({ saving: false });

  const write = async (raw: string) => {
    setState({ saving: true });
    try {
      await saveRawSynced(repo, note.key, raw);
      setDraft(null);
      setBase(null);
      setState({ saving: false });
      onSaved?.();
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

  return (
    <div className="flex flex-col gap-2" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) void commit(); }}>
      <div className="flex min-h-5 justify-end gap-2 empty:hidden">
        {state.saving && <LoaderCircle className="size-4 animate-spin" />}
        {draft !== null && !state.saving && <span className="badge badge-sm badge-ghost">unsaved</span>}
      </div>
      <YamlEditor value={draft ?? note.raw} inspect={(raw) => repo.inspect(note.key, raw)} onSave={() => void commit()} autofocus={autofocus}
                  onChange={(t) => { if (draft === null) setBase(note.raw); setDraft(t); }} />
      {state.conflict && draft !== null && (
        <div role="alert" className="alert alert-warning alert-soft py-2 text-sm">
          <span className="flex-1">This note was changed elsewhere meanwhile, in the same place as your edit. Not saved.</span>
          <button type="button" className="btn btn-xs" onClick={() => void write(draft)}>Overwrite</button>
          <button type="button" className="btn btn-xs" onClick={discard}>Discard my edits</button>
        </div>
      )}
      {state.error && <p className="text-sm text-error">{state.error}</p>}
    </div>
  );
}
