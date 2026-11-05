import { useState, type RefObject } from 'react';
import type { EditorView } from '@codemirror/view';
import { ListTodo, Plus } from 'lucide-react';
import { useRepo, type Json, type Lint } from '@gestalts/sdk';
import { Markdown, MarkdownEditor } from '../primitives';
import { useReferenceTools } from '../widgets/noteText';
import type { NoteMode } from './mode';

export type TextField = 'main' | 'extra' | 'tasks';

const text = (v: Json | undefined) => (typeof v === 'string' ? v : '');

/** The note's text as read: `tasks`, `main`, then `extra` below a rule. */
export function BodyView({ value, onOpen, empty }: { value: Record<string, Json | undefined>; onOpen?: (key: string) => void; empty?: string }) {
  const [tasks, main, extra] = [text(value.tasks), text(value.main), text(value.extra)];
  if (!tasks.trim() && !main.trim() && !extra.trim()) return empty ? <p className="text-sm text-base-content/50">{empty}</p> : null;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {tasks.trim() && (
        <div className="flex gap-2 rounded-box bg-warning/10 p-2 text-sm">
          <ListTodo className="mt-0.5 size-4 shrink-0" />
          <Markdown text={tasks} onOpen={onOpen} className="min-w-0 flex-1" />
        </div>
      )}
      {main.trim() && <Markdown text={main} onOpen={onOpen} />}
      {extra.trim() && <><hr className="border-base-300" /><Markdown text={extra} onOpen={onOpen} /></>}
    </div>
  );
}

/**
 * The note's title and text edited as Markdown, with `[[` completion; in `split`, rendered beside the editors (below
 * them on a narrow note). `extra` and `tasks` show once they have text or are asked for.
 */
export function BodyEditor({ noteKey, value, edit, mode, lints, onSave, onOpen, onFiles, views, active, autofocus, withTitle = true, fields = ['tasks', 'main', 'extra'] }: {
  noteKey: string;
  value: Record<string, Json | undefined>;
  edit: (patch: Record<string, Json | undefined>) => void;
  mode: NoteMode;
  lints: Lint[];
  onSave: () => void;
  onOpen?: (key: string) => void;
  /** files pasted or dropped into the text */
  onFiles?: (files: File[]) => void;
  /** the editors, for inserting a reference where the cursor is */
  views: RefObject<Partial<Record<TextField, EditorView | null>>>;
  /** the text field focused last */
  active: RefObject<TextField>;
  autofocus?: boolean;
  withTitle?: boolean;
  /** the text fields offered */
  fields?: TextField[];
}) {
  const repo = useRepo();
  const refs = useReferenceTools(noteKey);
  const [asked, setAsked] = useState<TextField[]>([]);
  const lintOf = (k: string) => lints.filter((l) => l.path.split('.')[0] === k);
  const shows = (k: TextField) => fields.includes(k) && (k === 'main' || asked.includes(k) || !!text(value[k]));
  const open = onOpen ? (target: string) => { const key = repo.keyOf(target); if (key) onOpen(key); } : undefined;
  const editor = (field: TextField, placeholder: string, focus = false) => (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- remembers where "link a note" inserts
    <div onFocus={() => { active.current = field; }}>
      <MarkdownEditor value={text(value[field])} onChange={(t) => edit({ [field]: t })} onSave={onSave} search={refs.search} labelOf={refs.labelOf}
                      onOpen={open} onFiles={onFiles} onView={(v) => { views.current[field] = v; }} placeholder={placeholder}
                      minHeight={field === 'main' ? '6rem' : '2.5rem'} autofocus={focus} />
      <Lints lints={lintOf(field)} />
    </div>
  );
  const missing = (['tasks', 'extra'] as const).filter((k) => fields.includes(k) && !shows(k));
  return (
    <div className="@container">
      <div className={`grid gap-3 ${mode === 'split' ? '@2xl:grid-cols-2' : ''}`}>
        <div className="flex min-w-0 flex-col gap-2">
          {withTitle && (
            <div>
              <input className="input input-sm w-full font-semibold" placeholder="Title" value={text(value.title)} onChange={(e) => edit({ title: e.target.value })}
                     onKeyDown={(e) => { if (e.key === 's' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSave(); } }} />
              <Lints lints={lintOf('title')} />
            </div>
          )}
          {shows('tasks') && editor('tasks', 'Tasks (Markdown)')}
          {editor('main', 'Text (Markdown; [[ links a note)', autofocus)}
          {shows('extra') && editor('extra', 'Extra (Markdown, shown below the text)')}
          {missing.length > 0 && (
            <div className="flex gap-1">
              {missing.map((k) => (
                <button key={k} type="button" className="btn btn-ghost btn-xs" onClick={() => setAsked([...asked, k])}>
                  <Plus className="size-3.5" /> {k === 'tasks' ? 'Tasks' : 'Extra'}
                </button>
              ))}
            </div>
          )}
        </div>
        {mode === 'split' && (
          <div className="min-w-0 rounded-box border border-dashed border-base-300 p-3" aria-label="Preview">
            <BodyView value={value} onOpen={onOpen} empty="Preview" />
          </div>
        )}
      </div>
    </div>
  );
}

/** Lints on a field, under it. */
export function Lints({ lints }: { lints: Lint[] }) {
  if (!lints.length) return null;
  return (
    <ul className="mt-0.5 text-xs text-warning">
      {lints.map((l) => <li key={`${l.gestalt} ${l.path} ${l.message}`}>{l.gestalt.split('@')[0]}: {l.path ? `${l.path} ` : ''}{l.message}</li>)}
    </ul>
  );
}
