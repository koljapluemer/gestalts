import { useRef, useState } from 'react';
import { X } from 'lucide-react';

const fold = (s: string) => s.trim().toLowerCase();

/**
 * `next` cleaned: trimmed, without empties, each once (case aside), and without any of `exclude` (a concept's own
 * name isn't an alias of it).
 */
export function cleanList(next: string[], exclude: string[] = []): string[] {
  const seen = new Set(exclude.map(fold));
  return next.map((x) => x.trim()).filter((x) => x && !seen.has(fold(x)) && !!seen.add(fold(x)));
}

/** One entry: a chip, edited in place on a click; emptied, it goes. */
function Chip({ value, label, onSave, onRemove }: { value: string; label: string; onSave: (v: string) => void; onRemove: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const cancelled = useRef(false);
  const done = () => {
    const next = editing ?? value;
    setEditing(null);
    if (cancelled.current) { cancelled.current = false; return; }
    if (next.trim() !== value) onSave(next);
  };
  if (editing !== null) {
    return (
      <input className="input input-xs w-40" aria-label={label} autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} onBlur={done}
             onKeyDown={(e) => {
               if (e.key === 'Enter') e.currentTarget.blur();
               if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur(); }
             }} />
    );
  }
  return (
    <span className="badge badge-ghost gap-0.5 pr-0.5">
      <button type="button" className="cursor-text" title={`Edit the ${label.toLowerCase()}`} onClick={() => setEditing(value)}>{value}</button>
      <button type="button" className="btn btn-ghost btn-xs btn-circle size-4 min-h-0" title={`Remove the ${label.toLowerCase()}`} onClick={onRemove}><X className="size-3" /></button>
    </span>
  );
}

/**
 * A list of short strings (aliases, tags) as chips: each edited in place or removed, more added by typing (a comma,
 * Enter or leaving the field adds what's typed). `onChange` gets the whole list, cleaned (`cleanList`).
 */
export function ListInput({ value, onChange, label, placeholder, exclude, prefix, className = '' }: {
  value: string[]; onChange: (next: string[]) => void;
  /** what one entry is called: "Alias" */
  label: string;
  placeholder?: string;
  /** never kept in the list */
  exclude?: string[];
  /** shown before the chips: "also" */
  prefix?: string;
  className?: string;
}) {
  const [adding, setAdding] = useState('');
  const save = (next: string[]) => {
    const clean = cleanList(next, exclude);
    if (clean.join('\n') !== value.join('\n')) onChange(clean);
  };
  const add = (text: string) => {
    const fresh = text.split(',').map((a) => a.trim()).filter(Boolean);
    setAdding('');
    if (fresh.length) save([...value, ...fresh]);
  };
  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`}>
      {prefix && <span className="text-xs text-base-content/60">{prefix}</span>}
      {value.map((a, i) => (
        <Chip key={`${a}:${i}`} value={a} label={label} onSave={(v) => save(value.map((x, j) => (j === i ? v : x)))} onRemove={() => save(value.filter((_, j) => j !== i))} />
      ))}
      <input className="input input-ghost input-xs w-36" aria-label={`Add ${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label.toLowerCase()}`} placeholder={placeholder ?? `Add ${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label.toLowerCase()}…`} value={adding}
             onChange={(e) => { if (e.target.value.endsWith(',')) add(e.target.value); else setAdding(e.target.value); }}
             onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(adding); } if (e.key === 'Escape') setAdding(''); }}
             onBlur={() => add(adding)} />
    </div>
  );
}
