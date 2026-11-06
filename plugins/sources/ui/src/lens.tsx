import { defineLens, type FieldProps, type JsonMap, type LensField } from '@gestalts/sdk';
import { fieldText, fieldValue, model } from './sourceModel';

const { entryTypes, fields } = model();
const kinds = new Map(fields);

/** Names and lists, one per line: names are `family, given`, so a comma doesn't separate them. */
function LinesField({ path, value, onChange }: FieldProps) {
  const kind = kinds.get(path);
  if (!onChange) {
    return Array.isArray(value)
      ? <ul>{value.map((v, i) => <li key={i}>{typeof v === 'string' ? v : JSON.stringify(v)}</li>)}</ul>
      : <span>{fieldText(value, kind) || '—'}</span>;
  }
  return <textarea className="textarea textarea-sm min-h-16 w-full" placeholder="one per line" value={fieldText(value, kind)} onChange={(e) => onChange(fieldValue(e.target.value, kind) ?? (e.target.value ? [] : undefined))} />;
}

const lines: Record<string, LensField> = Object.fromEntries(fields.filter(([, k]) => k === 'names' || k === 'list').map(([f]) => [f, { Field: LinesField }]));

const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);

/** `Family, Other and Third (2017)`, `Family et al. (2017)` past three; the editors when it has no authors. */
function byline(n: JsonMap): string {
  const people = names(n.author).length ? names(n.author) : names(n.editor);
  const family = people.map((p) => p.split(',')[0].trim());
  const who = family.length > 3 ? `${family[0]} et al.` : family.length > 1 ? `${family.slice(0, -1).join(', ')} and ${family.at(-1)}` : family[0] ?? '';
  const year = typeof n.date === 'string' ? n.date.slice(0, 4) : '';
  return [who, year && `(${year})`].filter(Boolean).join(' ');
}

/** A source: its citekey and entry type first, then the fields its entry type has (the others once set, or added). */
export const SourceLens = defineLens({
  gestalt: 'source@1',
  title: 'Source',
  priority: 1,
  fields: { ...lines, citekey: { order: 0 }, entrytype: { label: 'entry type', order: 1 }, bib_extra: { label: 'other BibTeX' } },
  offered: (note) => ['citekey', 'entrytype', ...(entryTypes.find(([t]) => t === (typeof note.entrytype === 'string' ? note.entrytype : 'misc'))?.[1] ?? [])],
  Summary: ({ note }) => (typeof note.citekey === 'string' ? <span className="shrink-0 font-mono text-xs opacity-70">{note.citekey}</span> : null),
  // read: who and when, under its title
  gist: { keys: ['author', 'editor', 'date'], blocks: (n) => { const by = byline(n); return by ? [{ kind: 'when', markdown: by }] : []; } },
});
