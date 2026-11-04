import { useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { Brackets, LoaderCircle, Plus } from 'lucide-react';
import { asMap, type IndexedNote, type Repo } from '@gestalts/sdk';
import { MarkdownEditor, insertReference } from '../primitives';
import { MediaGallery, MediaPicker } from './MediaGallery';
import { attachMedia, detachMedia, mediaOf } from './media';
import { applyTextDraft, textFields, textUneditable, useReferenceTools, type TextFields } from './noteText';
import { NoteBody } from './NoteView';

type Props = {
  note: IndexedNote;
  repo: Repo;
  /** a reference was Mod-clicked: the note's key */
  onOpen?: (key: string) => void;
  autofocus?: boolean;
};

type Field = 'main' | 'extra';

/**
 * A note's title, `main` and `extra` as Markdown, with `[[` completion and a live preview (beside the editor when
 * there's room, else below). Saves when focus leaves it and on Mod-s, merged into the note as it is by then (per
 * field), which also brings its inline relationships up to date. Images and videos are attached (upload, camera,
 * paste or drop) and written at once.
 */
export function NoteTextEditor({ note, repo, onOpen, autofocus }: Props) {
  const stored = textFields(note.value);
  const [draft, setDraft] = useState<TextFields | null>(null);
  const [base, setBase] = useState<TextFields | null>(null);
  const [state, setState] = useState<{ saving: boolean; error?: string; conflict?: boolean }>({ saving: false });
  const [attaching, setAttaching] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const [extraShown, setExtraShown] = useState(false);
  const refs = useReferenceTools(note.key);
  const views = useRef<Record<Field, EditorView | null>>({ main: null, extra: null });
  const active = useRef<Field>('main');

  const problem = textUneditable(note.value);
  if (problem) return <p className="text-sm text-warning">This note can't be edited as text: {problem}. Use YAML.</p>;

  const fields = draft ?? stored;
  const edit = (patch: Partial<TextFields>) => {
    if (draft === null) setBase(stored);
    setDraft({ ...fields, ...patch });
  };
  const discard = () => { setDraft(null); setBase(null); setState({ saving: false }); };
  const commit = async (force = false) => {
    if (draft === null) return;
    const current = asMap(repo.get(note.key)?.value);
    if (!current) { setState({ saving: false, error: 'The note is gone or no longer parses.' }); return; }
    const plan = applyTextDraft(current, base ?? stored, draft, force);
    if (plan.kind === 'conflict') { setState({ saving: false, conflict: true }); return; }
    if (JSON.stringify(plan.value) === JSON.stringify(current)) { discard(); return; }
    setState({ saving: true });
    try {
      await repo.putValue(note.key, plan.value);
      discard();
    } catch (e) {
      setState({ saving: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const open = onOpen ? (target: string) => { const key = repo.keyOf(target); if (key) onOpen(key); } : undefined;
  const attach = async (files: File[]) => {
    setAttaching({ busy: true });
    try {
      const r = await attachMedia(repo, note.key, files);
      setAttaching({ busy: false, error: r.errors.join(' ') || undefined });
    } catch (e) {
      setAttaching({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  const showExtra = extraShown || !!fields.extra;
  const editor = (field: Field, placeholder: string, focus = false) => (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- remembers where "insert reference" goes
    <div onFocus={() => { active.current = field; }}>
      <MarkdownEditor
        value={fields[field]}
        onChange={(t) => edit({ [field]: t })}
        onSave={() => void commit()}
        search={refs.search}
        labelOf={refs.labelOf}
        onOpen={open}
        onFiles={(files) => void attach(files)}
        onView={(v) => { views.current[field] = v; }}
        placeholder={placeholder}
        minHeight={field === 'main' ? '8rem' : '4rem'}
        autofocus={focus}
      />
    </div>
  );

  return (
    <div
      className="@container flex flex-col gap-2"
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) void commit(); }}
    >
      <div className="flex items-center gap-1">
        <MediaPicker onFiles={(files) => void attach(files)} disabled={attaching.busy} />
        <button type="button" className="btn btn-ghost btn-xs btn-square" title="Link a note ([[)"
                onClick={() => { const v = views.current[active.current] ?? views.current.main; if (v) insertReference(v); }}>
          <Brackets className="size-4" />
        </button>
        {attaching.busy && <LoaderCircle className="size-4 animate-spin" />}
        <span className="flex-1" />
        {state.saving && <LoaderCircle className="size-4 animate-spin" />}
        {draft !== null && !state.saving && <span className="badge badge-sm badge-ghost">unsaved</span>}
      </div>
      {attaching.error && <p role="alert" className="text-sm text-error">{attaching.error}</p>}
      <MediaGallery media={mediaOf(note)} onRemove={(file) => void detachMedia(repo, note.key, file)} />
      <div className="grid gap-3 @3xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-2">
          <input className="input input-sm w-full font-semibold" placeholder="Title" value={fields.title} onChange={(e) => edit({ title: e.target.value })}
                 onKeyDown={(e) => { if (e.key === 's' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void commit(); } }} />
          {editor('main', 'Text (Markdown; [[ links a note)', autofocus)}
          {showExtra
            ? editor('extra', 'Extra (Markdown, shown below the text)')
            : (
              <div>
                <button type="button" className="btn btn-ghost btn-xs" onClick={() => setExtraShown(true)}><Plus className="size-3.5" /> Extra</button>
              </div>
            )}
        </div>
        <div className="min-w-0 rounded-box border border-dashed border-base-300 p-3" aria-label="Preview">
          <NoteBody main={fields.main} extra={fields.extra} onOpen={onOpen} empty="Preview" />
        </div>
      </div>
      {state.conflict && draft !== null && (
        <div role="alert" className="alert alert-warning alert-soft py-2 text-sm">
          <span className="flex-1">This note's text was changed elsewhere meanwhile. Not saved.</span>
          <button type="button" className="btn btn-xs" onClick={() => void commit(true)}>Overwrite</button>
          <button type="button" className="btn btn-xs" onClick={discard}>Discard my edits</button>
        </div>
      )}
      {state.error && <p className="text-sm text-error">{state.error}</p>}
    </div>
  );
}
