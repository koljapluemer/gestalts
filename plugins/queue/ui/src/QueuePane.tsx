import { useEffect, useState } from 'react';
import { AlignLeft, EyeOff, LayoutList, SkipForward } from 'lucide-react';
import { definePane, definePerspective, useHost, type Query } from '@gestalts/sdk';
import { Note, type TagToggle } from '@gestalts/kit';
import { draw, HIDE_TAG, POOL, QUEUE_SIZE } from './queue';

/** tags the note `no-q`, to leave it out of the queue; toggled again, the tag comes off */
const HIDE: TagToggle[] = [{ tag: HIDE_TAG, icon: EyeOff, title: 'hide from the queue', activeTitle: 'hidden from the queue (click: back in it)' }];

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

    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-3 p-3">
        {!shown.length && <p className="my-6 text-base-content/50">{keys.length ? 'Nothing left of this draw.' : 'No notes to draw from.'}</p>}
        {shown.map((key) => (simple
          ? <Note key={key} noteKey={key} render="simple" tagToggles={HIDE} onOpen={onOpen} />
          : <Note key={key} noteKey={key} persist={`queue:${key}`} tagToggles={HIDE} onOpen={onOpen} onClose={() => close(key)} onDeleted={() => close(key)} />))}
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

export const QueuePane = definePane({ title: 'Queue', Component: () => <Queue /> });
