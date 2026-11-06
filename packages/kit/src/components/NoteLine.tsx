import { asMap, untitled, type IndexedNote } from '@gestalts/sdk';
import { HighlightedText } from '../primitives';
import { useNoteLine } from './NoteGist';

/** A note in one line, for list rows (search results, relationships): `noteLine` with search terms highlighted. */
export function NoteLine({ note, terms = [] }: { note: IndexedNote; terms?: string[] }) {
  const line = useNoteLine(asMap(note.value) ?? {});
  return (
    <span className="block truncate" title={line || undefined}>
      {line ? <HighlightedText text={line} terms={terms} /> : <span className="text-base-content/50">{untitled(note)}</span>}
    </span>
  );
}
