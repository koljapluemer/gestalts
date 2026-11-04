import type { ReactNode } from 'react';
import { FileText, ListTodo } from 'lucide-react';
import { fold, hashing, str, useBlobUrl, useQuery, type Card, type IndexedNote } from '@gestalts/sdk';
import { Markdown } from '../primitives';
import { MediaGallery } from './MediaGallery';
import { mediaOf, otherBlobs } from './media';

type Props = {
  note: IndexedNote;
  /** a `[[reference]]` was clicked: the note's key */
  onOpen?: (key: string) => void;
  /** given: media can be taken off the note */
  onRemoveMedia?: (file: string) => void;
};

const FLASHCARDS = { tagsAll: ['flashcard'] };

/**
 * A note for reading: its images and videos, `main` and `extra` as Markdown (math, `[[references]]`, `![[embeds]]`),
 * its cards, its `tasks`, and its other files. Relationships are the relationships widget's.
 */
export function NoteView({ note, onOpen, onRemoveMedia }: Props) {
  const oldCards = useQuery(FLASHCARDS);
  const cards = fold.readCards(note, fold.attached(oldCards, note.id, 'cards'), hashing).value ?? [];
  return (
    <NoteBody main={str(note, 'main') ?? ''} extra={str(note, 'extra') ?? ''} tasks={str(note, 'tasks') ?? ''} cards={cards}
              onOpen={onOpen} media={<MediaGallery media={mediaOf(note)} onRemove={onRemoveMedia} />} files={otherBlobs(note)}
              empty={note.parse_error ? 'This note\'s YAML doesn\'t parse; see YAML.' : 'Nothing to read here yet.'} />
  );
}

/** The rendered parts of a note, also the Text mode's preview. */
export function NoteBody({ main, extra, tasks = '', cards = [], media, files = [], onOpen, empty }: {
  main: string;
  extra: string;
  tasks?: string;
  cards?: Card[];
  media?: ReactNode;
  files?: { file: string; label: string | null }[];
  onOpen?: (key: string) => void;
  empty?: string;
}) {
  const nothing = !main.trim() && !extra.trim() && !tasks.trim() && !cards.length && !files.length;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {media}
      {tasks.trim() && (
        <div className="flex gap-2 rounded-box bg-warning/10 p-2 text-sm">
          <ListTodo className="mt-0.5 size-4 shrink-0" />
          <Markdown text={tasks} onOpen={onOpen} className="min-w-0 flex-1" />
        </div>
      )}
      {main.trim() && <Markdown text={main} onOpen={onOpen} />}
      {extra.trim() && <><hr className="border-base-300" /><Markdown text={extra} onOpen={onOpen} /></>}
      {cards.map((c) => (
        <div key={c.id || c.front} className="md-card rounded-box border border-base-300 p-3">
          <Markdown text={c.front} onOpen={onOpen} />
          <hr className="my-2 border-base-300" />
          <Markdown text={c.back} onOpen={onOpen} />
        </div>
      ))}
      {files.length > 0 && <ul className="flex flex-wrap gap-1">{files.map((f) => <FileLink key={f.file} {...f} />)}</ul>}
      {nothing && empty && <p className="text-sm text-base-content/50">{empty}</p>}
    </div>
  );
}

function FileLink({ file, label }: { file: string; label: string | null }) {
  const url = useBlobUrl(file);
  return (
    <li>
      <a className={`btn btn-xs ${url ? '' : 'btn-disabled'}`} href={url ?? undefined} target="_blank" rel="noopener" title={file}>
        <FileText className="size-3.5" /> {label ?? file}
      </a>
    </li>
  );
}
