import { createElement, useState, type ReactNode } from 'react';
import { CircleAlert, CircleDashed } from 'lucide-react';
import { seedFor, type FieldRule, type GestaltDef, type Json, type JsonMap, type Lint, type NoteGestalt } from '@gestalts/sdk';
import { DefaultField } from './fields/DefaultField';
import { Lints } from './Body';
import type { FieldSlot, Section } from './layout';

const nameOf = (id: string) => id.split('@')[0];
const TAGS: FieldRule = { type: 'string_list', required: false, min: null, max: null, one_of: null, fields: {}, items: null, values: null };

/** The gestalts a note has (filled) and those it's a candidate for but breaks (outlined, its lints on hover). */
export function GestaltLine({ gestalts, lints }: { gestalts: NoteGestalt[]; lints: Lint[] }) {
  if (!gestalts.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {gestalts.map((g) => {
        const own = lints.filter((l) => l.gestalt === g.id);
        return g.has
          ? <span key={g.id} className="badge badge-sm badge-primary badge-soft" title={g.id}>{nameOf(g.id)}</span>
          : (
            <span key={g.id} className="badge badge-sm badge-warning badge-outline gap-1" title={`almost ${g.id}:\n${own.map((l) => `${l.path ? `${l.path} ` : ''}${l.message}`).join('\n')}`}>
              <CircleDashed className="size-3" /> {nameOf(g.id)}
            </span>
          );
      })}
    </div>
  );
}

/**
 * The note's tags and its gestalts' fields, a section per gestalt (`layoutOf`), the fields no gestalt claims last.
 * Read: the fields it has, and the ones a gestalt requires that are missing. Edited: all of them. Sections not in
 * `focus` (when given) are folded into a line naming them.
 */
export function Properties({ value, edit, sections, focus, tags = true }: {
  value: JsonMap;
  /** given: editable */
  edit?: (patch: Record<string, Json | undefined>) => void;
  sections: Section[];
  /** only these sections open; the others behind "also" */
  focus?: string[];
  tags?: boolean;
}) {
  const [opened, setOpened] = useState<string[]>([]);
  const open = (s: Section) => !focus || focus.includes(s.id) || opened.includes(s.id);
  const shown = sections.filter(open);
  const folded = sections.filter((s) => !open(s));
  const tagList = Array.isArray(value.tags) ? value.tags : typeof value.tags === 'string' ? [value.tags] : [];
  if (!edit && !tagList.length && !shown.some((s) => s.fields.some(visible(false)) || s.lints.length) && !folded.length) return null;
  return (
    <div className="flex flex-col gap-2 text-sm">
      {tags && (edit || tagList.length > 0) && (
        <Row label="tags">
          <DefaultField path="tags" value={value.tags} rule={TAGS} note={value} onChange={edit ? (v) => edit({ tags: v }) : undefined} />
        </Row>
      )}
      {shown.map((s) => <SectionView key={s.id} section={s} value={value} edit={edit} />)}
      {folded.length > 0 && (
        <p className="flex flex-wrap items-center gap-1 text-xs text-base-content/60">
          also
          {folded.map((s) => <button key={s.id} type="button" className="btn btn-ghost btn-xs" onClick={() => setOpened([...opened, s.id])}>{s.title}</button>)}
        </p>
      )}
    </div>
  );
}

const visible = (editing: boolean, added: string[] = []) => (f: FieldSlot) =>
  f.set || f.required || f.lints.length > 0 || (editing && (f.offered || added.includes(f.path)));

function SectionView({ section: s, value, edit }: { section: Section; value: JsonMap; edit?: (patch: Record<string, Json | undefined>) => void }) {
  // fields asked for while editing, shown until they're filled in (an empty one isn't stored)
  const [added, setAdded] = useState<string[]>([]);
  const fields = s.fields.filter(visible(!!edit, added));
  const addable = edit ? s.fields.filter((f) => !fields.includes(f)) : [];
  if (!fields.length && !s.lints.length && !addable.length) return null;
  return (
    <section className="flex flex-col gap-1">
      <h3 className="flex items-center gap-1 text-xs font-semibold tracking-wide text-base-content/60 uppercase">
        {!s.has && <CircleDashed className="size-3 text-warning" aria-label="not complete" />}
        {s.title}
      </h3>
      {fields.map((f) => (
        <Row key={f.path} label={f.label} required={f.required} missing={!f.set} title={f.claimedBy.length > 1 ? `also ${f.claimedBy.slice(1).join(', ')}` : undefined}>
          {createElement(f.Field ?? DefaultField, { path: f.path, value: value[f.path], rule: f.rule, note: value, onChange: edit ? (v: Json | undefined) => edit({ [f.path]: v }) : undefined })}
          <Lints lints={f.lints} />
        </Row>
      ))}
      {addable.length > 0 && (
        <Row label="">
          <select className="select select-xs w-48" value="" aria-label="Add a field" onChange={(e) => { if (e.target.value) setAdded([...added, e.target.value]); }}>
            <option value="">add a field…</option>
            {addable.map((f) => <option key={f.path} value={f.path}>{f.label}</option>)}
          </select>
        </Row>
      )}
      <Lints lints={s.lints} />
    </section>
  );
}

function Row({ label, required, missing, title, children }: { label: string; required?: boolean; missing?: boolean; title?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(5rem,9rem)_1fr] items-start gap-2">
      <span className={`pt-1 text-xs ${missing && required ? 'text-warning' : 'text-base-content/60'}`} title={title}>
        {label}{required && <span aria-label="required">*</span>}
        {missing && required && <CircleAlert className="ml-1 inline size-3" aria-label="missing" />}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A gestalt to add to the note: picking one adds the tags it requires (its fields then show, to fill in). */
export function AddGestalt({ defs, value, edit, onDone }: { defs: GestaltDef[]; value: JsonMap; edit: (patch: Record<string, Json | undefined>) => void; onDone: () => void }) {
  const addable = defs.filter((d) => d.requires_tags.length).sort((a, b) => a.name.localeCompare(b.name));
  return (
    // oxlint-disable-next-line jsx-a11y/no-autofocus -- opened on purpose, to pick from
    <select className="select select-xs w-auto" autoFocus aria-label="Add a gestalt" defaultValue="" onBlur={onDone}
            onChange={(e) => {
              const def = addable.find((d) => `${d.name}@${d.version}` === e.target.value);
              if (def) edit({ tags: seedFor(def, value).tags });
              onDone();
            }}>
      <option value="" disabled>Add a gestalt…</option>
      {addable.map((d) => <option key={`${d.name}@${d.version}`} value={`${d.name}@${d.version}`} title={d.description ?? undefined}>{d.name}</option>)}
    </select>
  );
}
