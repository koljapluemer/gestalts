import { useState } from 'react';
import { Braces, Eye, FileQuestion, PenLine, Trash2, X } from 'lucide-react';
import { definePerspective, noteLabel, useNote, type IndexedNote, type Repo } from '@gestalts/sdk';
import { GestaltBadges } from '../components';
import { Conflicts, EditableNote, NoteParts, NoteTextEditor, NoteView, Relationships, detachMedia, saveRawSynced } from '../widgets';

type Props = {
  /** keys of the open notes, newest first */
  open: string[];
  onClose: (key: string) => void;
  /** a linked or related note was clicked; without it links are inert */
  onOpen?: (key: string) => void;
};

type Mode = 'view' | 'text' | 'yaml';

const MODES: { mode: Mode; title: string; Icon: typeof Eye }[] = [
  { mode: 'view', title: 'Read', Icon: Eye },
  { mode: 'text', title: 'Edit the text', Icon: PenLine },
  { mode: 'yaml', title: 'Edit as YAML', Icon: Braces },
];

/**
 * Any note: read (rendered), its text edited as Markdown, or all of it as raw YAML with live gestalt lints; its
 * relationships and backlinks, cards and template. Several can be open at once.
 */
export const UniversalEditor = definePerspective<Record<string, never>, Props>({
  id: 'universal-editor',
  title: 'Editor',
  data: {},
  Component: ({ open, onClose, onOpen, repo }) => {
    if (!open.length) {
      return <p className="p-8 text-center text-base-content/60">Open a note from the search, or create one.</p>;
    }
    return (
      <div className="flex flex-col gap-3 p-3">
        {open.map((key, i) => <OpenNote key={key} noteKey={key} autofocus={i === 0} onClose={() => onClose(key)} onOpen={onOpen} repo={repo} />)}
      </div>
    );
  },
});

// each note keeps the mode it was last shown in, for the browser session
const modeKey = (key: string) => `gestalts-note-mode:${key}`;

function storedMode(key: string): Mode {
  try {
    const m = sessionStorage.getItem(modeKey(key));
    if (m === 'view' || m === 'text' || m === 'yaml') return m;
  } catch { /* no storage */ }
  return 'view';
}

function OpenNote({ noteKey, autofocus, onClose, onOpen, repo }: {
  noteKey: string;
  autofocus: boolean;
  onClose: () => void;
  onOpen?: (key: string) => void;
  repo: Repo;
}) {
  const note = useNote(noteKey);
  const [mode, setModeState] = useState<Mode>(() => storedMode(noteKey));
  const setMode = (m: Mode) => {
    setModeState(m);
    try { sessionStorage.setItem(modeKey(noteKey), m); } catch { /* not remembered */ }
  };
  if (!note) {
    return (
      <div className="flex flex-col gap-2">
        <div role="alert" className="alert alert-soft">
          <FileQuestion className="size-4" />
          <span className="flex-1">{repo.isDeleted(noteKey) ? <>This note was deleted.</> : <>No note <code>{noteKey}</code> (not loaded).</>}</span>
          <button type="button" className="btn btn-xs" onClick={onClose}>Close</button>
        </div>
        <Conflicts noteKey={noteKey} onOpen={onOpen} />
      </div>
    );
  }
  const onDelete = () => {
    if (!confirm(`Delete this note?\n${noteKey}\n\nIts learner state goes with it.`)) return;
    void repo.delete(noteKey).then(onClose);
  };
  return (
    <div className="flex flex-col gap-2">
      <section className="card card-border bg-base-100">
        <div className="card-body gap-2 p-3">
          <header className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h2 className="truncate font-semibold">{noteLabel(note)}</h2>
              <p className="truncate font-mono text-xs text-base-content/50">{note.key}</p>
            </div>
            <div className="join" role="group" aria-label="Mode">
              {MODES.map(({ mode: m, title, Icon }) => (
                <button key={m} type="button" className={`btn btn-xs join-item ${m === mode ? 'btn-active' : ''}`} title={title} aria-pressed={m === mode}
                        onClick={() => setMode(m)}>
                  <Icon className="size-3.5" />
                </button>
              ))}
            </div>
            <button type="button" className="btn btn-ghost btn-xs btn-square" title="Delete note" onClick={onDelete}><Trash2 className="size-4" /></button>
            <button type="button" className="btn btn-ghost btn-xs btn-square" title="Close" onClick={onClose}><X className="size-4" /></button>
          </header>
          {mode !== 'yaml' && <GestaltBadges gestalts={note.gestalts} lints={note.lints} />}
          <Body mode={mode} note={note} repo={repo} onOpen={onOpen} autofocus={autofocus} />
        </div>
      </section>
      <Conflicts noteKey={note.key} onOpen={onOpen} />
      <Relationships note={note} repo={repo} onOpen={onOpen} />
      {mode !== 'view' && <NoteParts note={note} repo={repo} />}
    </div>
  );
}

function Body({ mode, note, repo, onOpen, autofocus }: { mode: Mode; note: IndexedNote; repo: Repo; onOpen?: (key: string) => void; autofocus: boolean }) {
  switch (mode) {
    case 'view':
      return <NoteView note={note} onOpen={onOpen} onRemoveMedia={(file) => void detachMedia(repo, note.key, file)} />;
    case 'text':
      return <NoteTextEditor note={note} repo={repo} onOpen={onOpen} autofocus={autofocus} />;
    case 'yaml':
      return <EditableNote bare note={note} autofocus={autofocus} inspect={(raw) => repo.inspect(note.key, raw)} save={(raw) => saveRawSynced(repo, note.key, raw)} />;
  }
}
