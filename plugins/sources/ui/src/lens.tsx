import { defineLens, type FieldProps, type LensField } from '@gestalts/sdk';
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

/** A source: its citekey and entry type first, then the fields its entry type has (the others once set, or added). */
export const SourceLens = defineLens({
  gestalt: 'source@1',
  title: 'Source',
  priority: 1,
  fields: { ...lines, citekey: { order: 0 }, entrytype: { label: 'entry type', order: 1 }, bib_extra: { label: 'other BibTeX' } },
  offered: (note) => ['citekey', 'entrytype', ...(entryTypes.find(([t]) => t === (typeof note.entrytype === 'string' ? note.entrytype : 'misc'))?.[1] ?? [])],
  Summary: ({ note }) => (typeof note.citekey === 'string' ? <span className="shrink-0 font-mono text-xs opacity-70">{note.citekey}</span> : null),
});
