import { useMemo } from 'react';
import { ListTodo } from 'lucide-react';
import { noteGist, noteLine, useHost, type GistBlock, type GistOptions, type GistPart, type JsonMap } from '@gestalts/sdk';
import { Markdown } from '../primitives';

/** The host's lenses' gist parts, before the built-in ones. */
export function useGistParts(): GistPart[] {
  const lenses = useHost().lenses;
  return useMemo(() => (lenses ?? []).flatMap((l) => (l.gist ? [l.gist] : [])), [lenses]);
}

/** The note in one line with the lenses' parts (`noteLine`): for list rows only. */
export function useNoteLine(value: JsonMap): string {
  const parts = useGistParts();
  return noteLine(value, parts);
}

/** The note's gist (`noteGist`) with the lenses' parts. */
export function useNoteGist(value: JsonMap, opts?: GistOptions): GistBlock[] {
  const parts = useGistParts();
  return noteGist(value, opts, parts);
}

/**
 * A note as read, whatever it has (`noteGist`): the title as a heading (a link to the note with `onOpenNote`), the
 * tasks in a box, the text, cards, link or canvas text as Markdown, `extra` smaller below a rule. Nothing when it has
 * none of them.
 */
export function NoteGist({ value, opts, onOpen, onOpenNote, className = '' }: {
  value: JsonMap;
  opts?: GistOptions;
  /** a linked note was clicked; without it links are inert */
  onOpen?: (key: string) => void;
  /** the heading was clicked */
  onOpenNote?: () => void;
  className?: string;
}) {
  const blocks = useNoteGist(value, opts);
  if (!blocks.length) return null;
  return (
    // a block, so its text flows around a floated header (Note's simple and compact views)
    <div className={`gist min-w-0 space-y-3 ${className}`}>
      {blocks.map((b, i) => <Block key={`${b.kind} ${i}`} block={b} onOpen={onOpen} onOpenNote={onOpenNote} />)}
    </div>
  );
}

function Block({ block: b, onOpen, onOpenNote }: { block: GistBlock; onOpen?: (key: string) => void; onOpenNote?: () => void }) {
  const md = (className = '') => <Markdown text={b.markdown} onOpen={onOpen} className={`gist-${b.kind} ${className}`} />;
  switch (b.kind) {
    case 'title':
      return onOpenNote
        ? <button type="button" className="nodrag cursor-pointer text-left hover:underline" title="Open" onClick={onOpenNote}>{md()}</button>
        : md();
    case 'tasks':
      return (
        <div className="flex gap-2 rounded-box bg-warning/10 p-2 text-sm">
          <ListTodo className="mt-0.5 size-4 shrink-0" />
          {md('min-w-0 flex-1')}
        </div>
      );
    case 'card':
      return <div className="md-card flow-root rounded-box border border-base-300 p-3">{md()}</div>;
    case 'extra':
      return <div className="flow-root"><hr className="mb-3 border-base-300" />{md()}</div>;
    default:
      return md();
  }
}
