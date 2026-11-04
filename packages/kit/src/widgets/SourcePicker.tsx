import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { str, strList, useQuery, type IndexedNote } from '@gestalts/sdk';
import { foldText } from '../primitives';

type Props = {
  onPick: (source: IndexedNote) => void;
  /** note ids offered first, in this order (e.g. the sources a document already relates to) */
  first?: string[];
  autofocus?: boolean;
  limit?: number;
};

/** The sources (`source@1`), filtered by citekey, title, names and date, for citing one. */
export function SourcePicker({ onPick, first = [], autofocus, limit = 30 }: Props) {
  const sources = useQuery({ tagsAll: ['source'] });
  const [text, setText] = useState('');
  const shown = useMemo(() => filterSources(sources, text, first).slice(0, limit), [sources, text, first, limit]);
  return (
    <div className="flex min-h-0 flex-col gap-1">
      <label className="input input-sm w-full">
        <Search className="size-4 opacity-50" />
        {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- opened on purpose, to type into */}
        <input type="search" autoFocus={autofocus} placeholder="Key, title, author, year" value={text}
               onChange={(e) => setText(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) onPick(shown[0]); }} />
      </label>
      <ul className="menu menu-sm min-h-0 w-full overflow-y-auto p-0">
        {shown.map((s) => (
          <li key={s.key}>
            <button type="button" onClick={() => onPick(s)} className="block text-left">
              <span className="font-mono text-xs">{str(s, 'citekey') ?? '?'}</span>{' '}
              <span className="text-base-content/70">{sourceSummary(s)}</span>
            </button>
          </li>
        ))}
        {!shown.length && <li className="px-3 py-2 text-sm text-base-content/60">No sources.</li>}
      </ul>
    </div>
  );
}

/** `Family et al. (2017): Title` */
export function sourceSummary(s: IndexedNote): string {
  const authors = strList(s, 'author').length ? strList(s, 'author') : strList(s, 'editor');
  const family = authors[0]?.split(',')[0];
  const who = family ? (authors.length > 1 ? `${family} et al.` : family) : '';
  const year = (str(s, 'date') ?? '').slice(0, 4);
  return [who && `${who}${year ? ` (${year})` : ''}`, str(s, 'title')].filter(Boolean).join(': ');
}

/** Sources whose citekey, title, names or date contain every word of `text`; those in `first` lead. */
export function filterSources(sources: IndexedNote[], text: string, first: string[] = []): IndexedNote[] {
  const terms = foldText(text).split(/\s+/).filter(Boolean);
  const hay = (s: IndexedNote) => foldText([str(s, 'citekey'), str(s, 'title'), str(s, 'date'), ...strList(s, 'author'), ...strList(s, 'editor')].join(' '));
  const rank = (s: IndexedNote) => { const i = first.indexOf(s.id); return i < 0 ? first.length : i; };
  return sources
    .filter((s) => terms.every((t) => hay(s).includes(t)))
    .sort((a, b) => rank(a) - rank(b) || (str(a, 'citekey') ?? '').localeCompare(str(b, 'citekey') ?? ''));
}
