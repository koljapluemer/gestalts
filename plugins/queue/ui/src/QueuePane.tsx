import { useEffect, useState, type ReactNode } from 'react';
import { AlignLeft, EyeOff, LayoutList, SkipForward } from 'lucide-react';
import { definePane, definePerspective, noteLabel, tags, useHost, type IndexedNote, type Query, type Repo } from '@gestalts/sdk';
import { NoteView, UniversalEditor } from '@gestalts/kit';
import { draw, HIDE_TAG, POOL, QUEUE_SIZE, withTag } from './queue';

/** The batch on screen, kept outside the pane, so it stays while other tabs are open; null until the first draw. */
let batch: string[] | null = null;

const SIMPLE_KEY = 'gestalts-queue-simple';

function storedSimple(): boolean {
  try { return sessionStorage.getItem(SIMPLE_KEY) === '1'; } catch { return false; }
}

function forQueue(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  const typing = t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
  return !typing && !e.metaKey && !e.ctrlKey && !e.altKey && !document.querySelector('dialog[open]');
}

/**
 * A few random notes of yours (see `POOL`), and Next (`n`) to draw others; shown simply (the body) or in full (the
 * editor), as toggled for the session. A note's hide toggle tags it `no-q`; it stays on screen until the next draw.
 */
const Queue = definePerspective<{ pool: Query }>({
  id: 'queue',
  title: 'Queue',
  data: { pool: POOL },
  Component: ({ data, repo }) => {
    const onOpen = useHost().openNote;
    const [, setDrawn] = useState(0);
    const [simple, setSimpleState] = useState(storedSimple);
    const setSimple = (on: boolean) => {
      setSimpleState(on);
      try { sessionStorage.setItem(SIMPLE_KEY, on ? '1' : '0'); } catch { /* not remembered */ }
    };
    const keys = data.pool.map((n) => n.key);
    const next = () => { batch = draw(keys, QUEUE_SIZE); setDrawn((d) => d + 1); };
    // the first draw waits for notes to draw from
    if (batch === null && keys.length) batch = draw(keys, QUEUE_SIZE);
    // deleted notes drop out; hidden ones stay until the next draw
    const shown = (batch ?? []).filter((k) => repo.get(k));
    const close = (key: string) => { batch = (batch ?? []).filter((k) => k !== key); setDrawn((d) => d + 1); };

    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== 'n' || !forQueue(e) || !keys.length) return;
        e.preventDefault();
        next();
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    });

    const hide = (note: IndexedNote) => <HideToggle note={note} repo={repo} />;
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-3 p-3">
        {!shown.length && <p className="my-6 text-base-content/50">{keys.length ? 'Nothing left of this draw.' : 'No notes to draw from.'}</p>}
        {simple
          ? shown.map((key) => <SimpleNote key={key} noteKey={key} repo={repo} onOpen={onOpen} actions={hide} />)
          : shown.length > 0 && <UniversalEditor open={shown} onClose={close} onOpen={onOpen} actions={hide} />}
        <div className="flex gap-2">
          <button type="button" className="btn btn-primary flex-1" title="n" disabled={!keys.length} onClick={next}>
            <SkipForward className="size-5" />Next
          </button>
          <button type="button" className="btn btn-square" title={simple ? 'simple (click: in full)' : 'in full (click: simple)'} aria-pressed={simple}
                  onClick={() => setSimple(!simple)}>
            {simple ? <AlignLeft className="size-5" /> : <LayoutList className="size-5" />}
          </button>
        </div>
      </div>
    );
  },
});

/** A note as its body only, with its label (opening it in the editor) and the hide toggle. */
function SimpleNote({ noteKey, repo, onOpen, actions }: { noteKey: string; repo: Repo; onOpen?: (key: string) => void; actions: (note: IndexedNote) => ReactNode }) {
  const note = repo.get(noteKey);
  if (!note) return null;
  return (
    <section className="card card-border bg-base-100">
      <div className="card-body gap-2 p-3">
        <header className="flex items-start gap-2">
          {onOpen
            ? <button type="button" className="min-w-0 flex-1 truncate text-left font-semibold hover:underline" onClick={() => onOpen(noteKey)}>{noteLabel(note)}</button>
            : <h2 className="min-w-0 flex-1 truncate font-semibold">{noteLabel(note)}</h2>}
          {actions(note)}
        </header>
        <NoteView note={note} onOpen={onOpen} />
      </div>
    </section>
  );
}

/** Tags the note `no-q` to leave it out of the queue; toggling again takes the tag off. */
function HideToggle({ note, repo }: { note: IndexedNote; repo: Repo }) {
  const on = tags(note).includes(HIDE_TAG);
  const [error, setError] = useState<string | null>(null);
  const toggle = () => {
    setError(null);
    repo.putValue(note.key, withTag(note.value, HIDE_TAG, !on))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <>
      {error && <span className="text-xs text-error" title={error}>not saved</span>}
      <button type="button" className={`btn btn-xs btn-square ${on ? 'btn-active' : 'btn-ghost'}`} aria-pressed={on}
              title={on ? 'hidden from the queue (click: back in it)' : 'hide from the queue'} onClick={toggle}>
        <EyeOff className="size-4" />
      </button>
    </>
  );
}

export const QueuePane = definePane({ title: 'Queue', Component: () => <Queue /> });
