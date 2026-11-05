import { useState } from 'react';
import { X } from 'lucide-react';
import { asMap, useBlobUrl, useRepo, type FieldProps, type FieldRule, type Json } from '@gestalts/sdk';
import { Markdown } from '../../primitives';
import { inferType } from '../layout';

const INPUT = 'input input-sm w-full';

/** A field shown, or edited, as its gestalt type says (or as its value looks, when no gestalt claims it). */
export function DefaultField(props: FieldProps) {
  const { rule, value, onChange } = props;
  const type = rule?.type && rule.type !== 'any' ? rule.type : inferType(value);
  if (rule?.one_of?.length) return <Choice {...props} options={rule.one_of} />;
  if (!onChange) return <Shown type={type} value={value} />;
  switch (type) {
    case 'string': case 'url': case 'partial_date':
      return <input className={INPUT} type={type === 'url' ? 'url' : 'text'} value={typeof value === 'string' ? value : ''}
                    placeholder={type === 'partial_date' ? 'YYYY, YYYY-MM or YYYY-MM-DD (a range: from/to)' : undefined}
                    onChange={(e) => onChange(e.target.value)} />;
    case 'text':
      return <textarea className="textarea textarea-sm w-full" rows={3} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />;
    case 'number': case 'integer':
      return <NumberInput value={value} integer={type === 'integer'} rule={rule} onChange={onChange} />;
    case 'bool':
      return <input type="checkbox" className="toggle toggle-sm" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
    case 'date':
      return <input className={INPUT} type="date" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)} />;
    case 'datetime':
      return <input className={INPUT} type="datetime-local" value={typeof value === 'string' ? value.slice(0, 16) : ''} onChange={(e) => onChange(e.target.value || undefined)} />;
    case 'string_list':
      return <StringList value={value} onChange={onChange} />;
    case 'blob':
      return <BlobChoice {...props} />;
    default:
      return <YamlValue value={value} onChange={onChange} />;
  }
}

function Shown({ type, value }: { type: FieldRule['type']; value: Json | undefined }) {
  if (value === undefined) return <span className="text-base-content/40">—</span>;
  switch (type) {
    case 'url':
      return typeof value === 'string' ? <a className="link break-all" href={value} target="_blank" rel="noopener">{value}</a> : <Raw value={value} />;
    case 'text':
      return typeof value === 'string' ? <Markdown text={value} /> : <Raw value={value} />;
    case 'bool':
      return <span>{value ? 'yes' : 'no'}</span>;
    case 'string_list':
      return Array.isArray(value) ? <span className="flex flex-wrap gap-1">{value.map((v, i) => <span key={i} className="badge badge-sm badge-ghost">{String(v)}</span>)}</span> : <Raw value={value} />;
    case 'blob':
      return typeof value === 'string' ? <BlobLink file={value} /> : <Raw value={value} />;
    case 'list': case 'map': case 'any':
      return <Raw value={value} />;
    default:
      return <span className="break-words">{typeof value === 'string' ? value : JSON.stringify(value)}</span>;
  }
}

function Raw({ value }: { value: Json }) {
  return <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-base-200 p-1 text-xs">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>;
}

function Choice({ value, onChange, options }: FieldProps & { options: Json[] }) {
  const at = options.findIndex((o) => JSON.stringify(o) === JSON.stringify(value ?? null));
  if (!onChange) return <span>{value === undefined ? '—' : typeof value === 'string' ? value : JSON.stringify(value)}</span>;
  return (
    <select className="select select-sm w-full" value={at} onChange={(e) => { const i = Number(e.target.value); onChange(i < 0 ? undefined : options[i]); }}>
      <option value={-1}>—</option>
      {options.map((o, i) => <option key={i} value={i}>{typeof o === 'string' ? o : JSON.stringify(o)}</option>)}
    </select>
  );
}

function NumberInput({ value, integer, rule, onChange }: { value: Json | undefined; integer: boolean; rule: FieldRule | null; onChange: (v: Json | undefined) => void }) {
  // the text as typed, so "1." or "-" can be on the way to a number
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (typeof value === 'number' ? String(value) : '');
  return (
    <input className={INPUT} type="number" inputMode={integer ? 'numeric' : 'decimal'} step={integer ? 1 : 'any'} min={rule?.min ?? undefined} max={rule?.max ?? undefined}
           value={shown} onBlur={() => setText(null)}
           onChange={(e) => {
             setText(e.target.value);
             const n = e.target.valueAsNumber;
             onChange(e.target.value === '' ? undefined : Number.isNaN(n) ? value : n);
           }} />
  );
}

function StringList({ value, onChange }: { value: Json | undefined; onChange: (v: Json | undefined) => void }) {
  const items = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : typeof value === 'string' ? [value] : [];
  const [text, setText] = useState('');
  const add = () => {
    const t = text.trim();
    if (t && !items.includes(t)) onChange([...items, t]);
    setText('');
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      {items.map((t) => (
        <span key={t} className="badge badge-sm gap-0.5 pr-0.5">
          {t}
          <button type="button" className="btn btn-ghost btn-xs h-4 min-h-0 w-4 p-0" title={`Remove ${t}`} onClick={() => onChange(items.filter((i) => i !== t))}><X className="size-3" /></button>
        </span>
      ))}
      <input className="input input-xs min-w-24 flex-1" placeholder="add…" value={text} onChange={(e) => setText(e.target.value)} onBlur={add}
             onKeyDown={(e) => {
               if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
               else if (e.key === 'Backspace' && !text && items.length) onChange(items.slice(0, -1));
             }} />
    </div>
  );
}

function BlobChoice({ value, onChange, note }: FieldProps) {
  const files = (Array.isArray(note.blobs) ? note.blobs : []).flatMap((b) => {
    const f = typeof b === 'string' ? b : asMap(b)?.file;
    return typeof f === 'string' ? [f] : [];
  });
  if (!onChange) return typeof value === 'string' ? <BlobLink file={value} /> : <span>—</span>;
  return (
    <select className="select select-sm w-full" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">—</option>
      {files.map((f) => <option key={f} value={f}>{f}</option>)}
    </select>
  );
}

function BlobLink({ file }: { file: string }) {
  const url = useBlobUrl(file);
  return <a className={`link ${url ? '' : 'pointer-events-none opacity-50'}`} href={url ?? undefined} target="_blank" rel="noopener">{file}</a>;
}

/** Any other value, as YAML (or JSON) text, read by the core when focus leaves it. */
function YamlValue({ value, onChange }: { value: Json | undefined; onChange: (v: Json | undefined) => void }) {
  const repo = useRepo();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = text ?? (value === undefined ? '' : JSON.stringify(value, null, 2));
  const read = () => {
    if (text === null) return;
    if (!text.trim()) { onChange(undefined); setText(null); setError(null); return; }
    const n = repo.inspect('field', `v:\n${text.split('\n').map((l) => `  ${l}`).join('\n')}\n`);
    const v = asMap(n.value)?.v;
    if (n.parse_error || v === undefined) { setError(n.parse_error?.message ?? 'not a value'); return; }
    onChange(v);
    setText(null);
    setError(null);
  };
  return (
    <div className="flex flex-col gap-1">
      <textarea className="textarea textarea-sm w-full font-mono text-xs" rows={Math.min(10, shown.split('\n').length + 1)} value={shown}
                onChange={(e) => setText(e.target.value)} onBlur={read} aria-invalid={error !== null} />
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}
