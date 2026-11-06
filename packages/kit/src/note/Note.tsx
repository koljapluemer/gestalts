import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { EditorView } from '@codemirror/view';
import { Braces, Brackets, CircleAlert, FileQuestion, FileText, LoaderCircle, Maximize2, PenLine, Plus, Shapes, Trash2, X } from 'lucide-react';
import {
  noteGestalts, noteLabel, tags as tagsOf, untitled, useBlobUrl, useHost, useNote, useRepo, withTag,
  type GistOptions, type IndexedNote, type Json, type JsonMap, type NoteSeed,
} from '@gestalts/sdk';
import { insertReference } from '../primitives';
import { NoteLine } from '../components';
import { Conflicts } from '../widgets/Conflicts';
import { MediaGallery, MediaPicker } from '../widgets/MediaGallery';
import { attachMedia, detachMedia, mediaOf, otherBlobs } from '../widgets/media';
import { Relationships } from '../widgets/Relationships';
import { BodyEditor, Lints, type TextField } from './Body';
import { NoteGist, useNoteLine } from '../components';
import { BODY_KEYS, PART_KEYS, layoutOf } from './layout';
import { isMode, resolveMode, type NoteMode } from './mode';
import { PartsEditor, StaleFolds, useParts } from './Parts';
import { AddGestalt, GestaltLine, Properties } from './Properties';
import { SourceEditor } from './SourceEditor';
import { Extra, ModeToggle, ToolButton, type ExtraTool, type TagToggle, type ToolId } from './tools';
import { useNoteDraft } from './useNoteDraft';

export type NoteProps = {
  /** the note; without it, a new one from `seed` */
  noteKey?: string;
  /** a new note: its value so far, gestalt, relationship and preset (see `NoteSeed`) */
  seed?: NoteSeed;
  /** `full` (default); `simple`: the note as read (`NoteGist`) and its media; `inline`: one line (`noteLine`), for list rows */
  render?: 'full' | 'simple' | 'inline';
  /** the modes offered (default view and edit; a new note only edits); the toggle hides when there's one */
  modes?: readonly NoteMode[];
  /** the mode shown first (default view) */
  defaultMode?: NoteMode;
  /** the mode, when the caller keeps it (the Graph's one card in edit) */
  mode?: NoteMode;
  onModeChange?: (mode: NoteMode) => void;
  /** a key keeping the mode chosen, for the browser tab's session: per view (`daily`), per view and note (`explorer:<key>`) */
  persist?: string;
  /** `blur` (default): edits are written as focus leaves the note, and on Mod-s; `explicit`: Save and Discard. A new note is always explicit (Create) */
  commit?: 'blur' | 'explicit';
  /** the relationships (default on, `full` only); `readonly`: the rows only */
  relationships?: boolean | 'readonly';
  /** switch tools off, or `edit` on in `full`; by default each shows where it applies */
  tools?: Partial<Record<ToolId, boolean>>;
  tagToggles?: TagToggle[];
  /** the page's own tools, first in the row */
  extraTools?: ExtraTool[];
  /** `name@version` of the gestalts whose fields show open (the others behind "also"); default all */
  lenses?: 'all' | string[];
  /** smaller: no properties beyond the gestalts; read, the note as `simple` shows it (Graph and Canvas cards) */
  compact?: boolean;
  /** what the note as read shows (`noteGist`): e.g. `{ tasks: false }` where they're beside the point (Float) */
  gist?: GistOptions;
  autofocus?: boolean;
  /** a linked or related note was clicked; without it links are inert */
  onOpen?: (key: string) => void;
  /** the `edit` tool (simple, inline) does this instead of opening the note in the host's editor */
  onEdit?: () => void;
  /** deletes instead of the repo's delete (the Graph's, with its own undo); resolves to whether it did */
  onDelete?: () => Promise<boolean>;
  onDeleted?: () => void;
  /** a new note, once written */
  onCreated?: (key: string) => void;
  /** a new note given up */
  onCancel?: () => void;
  /** a close button */
  onClose?: () => void;
  /** Esc with nothing unsaved; by default it leaves the editor */
  onEscape?: () => void;
  className?: string;
};

/**
 * A note, wherever one is shown: read, edited or both, with its tools, media and relationships, as its parameters ask
 * (doc/architecture.md#the-note-component). Its fields are shown by the gestalts it has or is a candidate for: each
 * gestalt's lens claims its fields, a field claimed by several shows once, a required one missing shows to be filled.
 */
export function Note(props: NoteProps) {
  const repo = useRepo();
  const note = useNote(props.noteKey ?? '');
  if (props.noteKey === undefined) return <LoadedNote {...props} note={undefined} />;
  if (!note) {
    return (
      <div className={`flex flex-col gap-2 ${props.className ?? ''}`}>
        <div role="alert" className="alert alert-soft">
          <FileQuestion className="size-4" />
          <span className="flex-1">{repo.isDeleted(props.noteKey) ? <>This note was deleted.</> : <>No note <code>{props.noteKey}</code> (not loaded).</>}</span>
          {props.onClose && <button type="button" className="btn btn-xs" onClick={props.onClose}>Close</button>}
        </div>
        <Conflicts noteKey={props.noteKey} onOpen={props.onOpen} />
      </div>
    );
  }
  return <LoadedNote {...props} note={note} />;
}

/** The fields the full view reads as text; its properties show the others. */
const inBody = (key: string) => (BODY_KEYS as readonly string[]).includes(key) || (PART_KEYS as readonly string[]).includes(key);

const modeKey = (persist: string) => `gestalts-note-mode:${persist}`;

function storedMode(persist: string | undefined): NoteMode | undefined {
  if (!persist) return undefined;
  try {
    const m = sessionStorage.getItem(modeKey(persist));
    return isMode(m) ? m : undefined;
  } catch { return undefined; }
}

const DEFAULT_MODES: readonly NoteMode[] = ['view', 'edit'];

function LoadedNote({
  note, seed, render = 'full', modes: modesAsked = DEFAULT_MODES, defaultMode = 'view', mode: modeAsked, onModeChange, persist,
  commit: commitPolicy = 'blur', relationships = true, tools = {}, tagToggles = [], extraTools = [], lenses: lensesAsked = 'all',
  compact = false, gist = {}, autofocus = false, onOpen, onEdit, onDelete, onDeleted, onCreated, onCancel, onClose, onEscape, className = '',
}: NoteProps & { note: IndexedNote | undefined }) {
  const repo = useRepo();
  const host = useHost();
  const hostLenses = useMemo(() => host.lenses ?? [], [host.lenses]);
  const defs = useMemo(() => repo.gestalts(), [repo]);
  const draft = useNoteDraft({ repo, note, seed, lenses: hostLenses, defs, commitOnUnmount: commitPolicy === 'blur' });
  const isNew = draft.isNew;
  const [preset, setPreset] = useState(seed?.preset ?? (isNew ? 'capture' : 'full'));
  const [kept, setKept] = useState<NoteMode | undefined>(() => storedMode(persist));
  const [source, setSource] = useState(false);
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const views = useRef<Partial<Record<TextField, EditorView | null>>>({});
  const active = useRef<TextField>('main');

  const modes = isNew ? (['edit'] as const) : modesAsked;
  const mode = render === 'full' ? resolveMode(modes, modeAsked ?? kept, isNew ? 'edit' : defaultMode) : 'view';
  const editing = mode !== 'view';
  const explicit = isNew || commitPolicy === 'explicit';
  const live = draft.live;
  const gestalts = noteGestalts(live);
  const focus = lensesAsked !== 'all' ? lensesAsked : preset === 'gestalt' && seed?.gestalt ? [seed.gestalt] : undefined;
  const { sections, bodyLints } = layoutOf({ value: draft.value, lints: live.lints, gestalts, defs, lenses: hostLenses, focus });
  const parts = useParts(note, draft.value);
  const has = (id: ToolId, byDefault: boolean) => tools[id] ?? byDefault;
  const lensOf = (id: string) => hostLenses.find((l) => l.gestalt === id);
  const line = useNoteLine(draft.value);
  const summaries = gestalts.flatMap((g) => { const S = lensOf(g.id)?.Summary; return S ? [<S key={g.id} note={draft.value} />] : []; });

  const setMode = async (next: NoteMode) => {
    if (next === mode) return;
    if (!explicit && draft.dirty && !(await draft.commit())) return;
    setKept(next);
    if (persist) { try { sessionStorage.setItem(modeKey(persist), next); } catch { /* not remembered */ } }
    onModeChange?.(next);
  };
  const act = (work: Promise<unknown>) => { setProblem(null); work.catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e))); };
  const create = async () => {
    const key = await draft.commit();
    if (key) onCreated?.(key);
  };
  const save = () => (isNew ? void create() : void draft.commit());
  const attach = (files: File[]) => {
    if (isNew) { draft.stage(files); return; }
    act(attachMedia(repo, draft.key, files).then((r) => { if (r.errors.length) throw new Error(r.errors.join(' ')); }));
  };
  const remove = async () => {
    if (onDelete) { if (await onDelete()) onDeleted?.(); return; }
    if (!confirm(`Delete this note?\n${noteLabel(live)}\n\nIts learner state goes with it.`)) return;
    await repo.delete(draft.key);
    (onDeleted ?? onClose)?.();
  };
  const toggleTag = (t: TagToggle, on: boolean) => {
    if (isNew) { draft.edit({ tags: (withTag(draft.value, t.tag, on) as { tags?: Json }).tags }); return; }
    act(repo.putValue(draft.key, withTag(repo.get(draft.key)?.value ?? null, t.tag, on)));
  };
  const toSource = async (on: boolean) => {
    if (on && draft.dirty && !(await draft.commit())) return;
    setSource(on);
  };
  const edit = () => (onEdit ? onEdit() : host.openNote?.(draft.key));
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && editing) { e.preventDefault(); save(); }
    else if (e.key === 'Escape' && editing && !draft.dirty) {
      if (isNew && onCancel) { e.preventDefault(); e.stopPropagation(); onCancel(); }
      else if (onEscape) { e.preventDefault(); onEscape(); }
      else if (modes.includes('view')) { e.preventDefault(); void setMode('view'); }
    }
  };

  const toolRow: ReactNode = (
    <>
      {extraTools.map((t) => <Extra key={t.key} tool={t} />)}
      {editing && !source && has('media', true) && <MediaPicker onFiles={attach} />}
      {editing && !source && has('reference', true) && (
        <ToolButton title="Link a note ([[)" onClick={() => { const v = views.current[active.current] ?? views.current.main; if (v) insertReference(v); }}>
          <Brackets className="size-4" />
        </ToolButton>
      )}
      {editing && !source && preset === 'full' && has('addGestalt', true) && (
        adding
          ? <AddGestalt defs={defs} value={draft.value} edit={draft.edit} onDone={() => setAdding(false)} />
          : <ToolButton title="Add a gestalt (its tags, then its fields)" onClick={() => setAdding(true)}><Shapes className="size-4" /></ToolButton>
      )}
      {tagToggles.map((t) => {
        const on = tagsOf({ ...live, value: draft.value }).includes(t.tag);
        const Icon = on ? (t.activeIcon ?? t.icon) : t.icon;
        return <ToolButton key={t.tag} title={on ? (t.activeTitle ?? t.title) : t.title} active={on} onClick={() => toggleTag(t, !on)}><Icon className="size-4" /></ToolButton>;
      })}
      {render !== 'full' && has('edit', true) && (onEdit || host.openNote) && (
        <ToolButton title="Edit" onClick={edit}><PenLine className="size-4" /></ToolButton>
      )}
      {render === 'full' && !isNew && has('source', true) && (
        <ToolButton title={source ? 'Back to the fields' : 'Edit the source (YAML)'} active={source} onClick={() => void toSource(!source)}><Braces className="size-4" /></ToolButton>
      )}
      {!isNew && has('delete', true) && (
        <ToolButton title="Delete the note" danger onClick={() => act(remove())}><Trash2 className="size-4" /></ToolButton>
      )}
    </>
  );
  const status: ReactNode = draft.state.saving
    ? <LoaderCircle className="size-4 animate-spin" />
    : draft.dirty && !isNew && !explicit ? <span className="badge badge-sm badge-ghost">unsaved</span> : null;
  const lintIcon = live.lints.length > 0 && (
    <span className="shrink-0 text-warning" title={live.lints.map((l) => `${l.gestalt} ${l.path}: ${l.message}`).join('\n')}>
      <CircleAlert className="size-3.5" aria-label={`${live.lints.length} problems`} />
    </span>
  );
  const parseIcon = live.parse_error && (
    <span className="shrink-0 text-error" title="This note's YAML doesn't parse; see its source.">
      <CircleAlert className="size-3.5" aria-label="doesn't parse" />
    </span>
  );
  // read in simple, or compact: the note as `NoteGist` shows it, its title a heading, the tools floated beside it
  const reading = !source && (render === 'simple' || (compact && !editing && !isNew));
  const title = typeof draft.value.title === 'string' ? draft.value.title.trim() : '';
  const openThis = onOpen && !isNew ? () => onOpen(draft.key) : undefined;
  const header = (() => {
    if (isNew) return <span className="flex-1 text-sm text-base-content/60">New note</span>;
    // compact, edited: one line naming it, as a list row would
    if (compact) {
      const text = line || untitled(live);
      return openThis
        ? <button type="button" className="nodrag min-w-0 flex-1 truncate text-left text-sm font-semibold hover:underline" title={text} onClick={openThis}>{text}</button>
        : <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={text}>{text}</span>;
    }
    // full: the title whole (the text below has the rest)
    return <span className="min-w-0 flex-1 font-semibold break-words">{editing ? '' : title}</span>;
  })();
  const controls: ReactNode = (
    <>
      {summaries}
      {parseIcon}
      <div className="flex flex-wrap items-center justify-end gap-0.5">{toolRow}</div>
      {status}
      {render === 'full' && !(explicit && draft.dirty && !isNew) && <ModeToggle modes={modes} mode={mode} onMode={(m) => void setMode(m)} />}
      {explicit && draft.dirty && !isNew && (
        <>
          <button type="button" className="btn btn-ghost btn-xs" onClick={draft.discard}>Discard</button>
          <button type="button" className="btn btn-primary btn-xs" onClick={() => void draft.commit()}>Save</button>
        </>
      )}
      {onClose && <ToolButton title="Close" onClick={onClose}><X className="size-4" /></ToolButton>}
    </>
  );

  if (render === 'inline') {
    return (
      <div className={`flex min-w-0 items-center gap-1 ${className}`}>
        {onOpen
          ? <button type="button" className="min-w-0 flex-1 cursor-pointer text-left hover:underline" onClick={() => onOpen(draft.key)}><NoteLine note={live} /></button>
          : <span className="min-w-0 flex-1"><NoteLine note={live} /></span>}
        {summaries}
        {lintIcon}
        {toolRow}
      </div>
    );
  }

  const files = otherBlobs(live);
  const media = mediaOf(live);
  // cards still in attached notes read as the note's own
  const gistValue: JsonMap = parts.cards && draft.value.cards === undefined
    ? { ...draft.value, cards: parts.cards.map((c) => ({ id: c.id, front: c.front, back: c.back })) }
    : draft.value;
  const body = (() => {
    if (source && note) return <SourceEditor note={note} autofocus onSaved={() => setSource(false)} />;
    if (reading) return null;
    if (!editing) {
      return (
        <>
          <MediaGallery media={media} onRemove={(file) => act(detachMedia(repo, draft.key, file))} />
          <NoteGist value={gistValue} opts={{ ...gist, title: false, only: inBody }} onOpen={onOpen} />
          <Lints lints={bodyLints.filter((l) => !l.path)} />
        </>
      );
    }
    return (
      <>
        <MediaGallery media={media} onRemove={(file) => act(detachMedia(repo, draft.key, file))} />
        {draft.staged.length > 0 && (
          <ul className="flex flex-wrap gap-1">
            {draft.staged.map((f, i) => (
              <li key={`${f.name} ${i}`} className="badge gap-1">{f.name}
                <button type="button" className="btn btn-ghost btn-xs h-4 min-h-0 w-4 p-0" title="Leave it out" onClick={() => draft.unstage(f)}><X className="size-3" /></button>
              </li>
            ))}
          </ul>
        )}
        {note && <StaleFolds stale={parts.stale} noteKey={draft.key} repo={repo} onResolved={draft.discard} />}
        <BodyEditor noteKey={draft.key} value={draft.value} edit={draft.edit} mode={mode} lints={bodyLints} onSave={save} onOpen={onOpen} onFiles={attach}
                    views={views} active={active} autofocus={autofocus} fields={preset === 'capture' ? ['main'] : undefined} />
        {preset === 'full' && <PartsEditor cards={parts.cards} template={parts.template} edit={draft.edit} onSave={save} />}
        <Lints lints={bodyLints.filter((l) => !l.path)} />
      </>
    );
  })();

  return (
    <div className={`flex min-w-0 flex-col gap-2 ${className}`}>
      <section
        className={`card card-border bg-base-100 ${compact ? 'text-sm' : ''}`}
        onBlur={(e) => { if (!explicit && !e.currentTarget.contains(e.relatedTarget)) void draft.commit(); }}
        onKeyDown={onKeyDown}
      >
        <div className={`card-body gap-2 ${compact ? 'p-2' : 'p-3'}`}>
          {reading ? (
            // a block, not flex, so the text flows around the tools instead of being narrowed by them
            <div className="min-w-0">
              <header className="float-right mb-1 ml-2 flex items-center gap-0.5">{controls}</header>
              <MediaGallery media={media} />
              <NoteGist value={gistValue} opts={gist} onOpen={onOpen} onOpenNote={openThis} className={media.length ? 'mt-2' : ''} />
            </div>
          ) : <header className="flex items-start gap-1">{header}{controls}</header>}
          {!editing && !isNew && !compact && render === 'full' && <p className="-mt-2 truncate font-mono text-xs text-base-content/40">{draft.key}</p>}
          {render === 'full' && preset !== 'capture' && !source && <GestaltLine gestalts={gestalts} lints={live.lints} />}
          {render === 'full' && !compact && preset !== 'capture' && !source && (
            <Properties value={draft.value} edit={editing ? draft.edit : undefined} sections={sections} focus={focus} tags={preset === 'full'} />
          )}
          {body}
          {files.length > 0 && !source && <ul className="flex flex-wrap gap-1">{files.map((f) => <FileLink key={f.file} {...f} />)}</ul>}
          {draft.state.conflict && draft.dirty && (
            <div role="alert" className="alert alert-warning alert-soft py-2 text-sm">
              <span className="flex-1">This note was changed elsewhere meanwhile ({draft.state.conflict.join(', ')}). Not saved.</span>
              <button type="button" className="btn btn-xs" onClick={() => void draft.commit(true)}>Overwrite</button>
              <button type="button" className="btn btn-xs" onClick={draft.discard}>Discard my edits</button>
            </div>
          )}
          {(draft.state.error || problem) && <p role="alert" className="text-sm text-error">{draft.state.error ?? problem}</p>}
          {isNew && (
            <footer className="flex flex-wrap items-center justify-end gap-2">
              {preset !== 'full' && (
                <button type="button" className="btn btn-ghost btn-sm mr-auto" title="Every field, tags and gestalts" onClick={() => setPreset('full')}>
                  <Maximize2 className="size-4" /> More…
                </button>
              )}
              {onCancel && <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>}
              <button type="button" className="btn btn-primary btn-sm" title="Mod-Enter" disabled={draft.state.saving} onClick={() => void create()}>
                {draft.state.saving ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />} Create
              </button>
            </footer>
          )}
        </div>
      </section>
      {render === 'full' && !isNew && !compact && <Conflicts noteKey={draft.key} onOpen={onOpen} />}
      {render === 'full' && !isNew && relationships !== false && note && (
        <Relationships note={note} repo={repo} onOpen={onOpen} readOnly={relationships === 'readonly'} />
      )}
      {isNew && seed?.relate && <RelatedFrom from={seed.relate.from} label={seed.relate.label} />}
    </div>
  );
}

/** A new note's relationship from another, written with it. */
function RelatedFrom({ from, label }: { from: string; label?: string }) {
  const n = useNote(from);
  return <p className="px-1 text-xs text-base-content/60">Related from <span className="font-semibold">{n ? noteLabel(n) : from}</span>{label ? ` (${label})` : ''}</p>;
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
