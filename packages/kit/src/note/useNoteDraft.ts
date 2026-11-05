import { useEffect, useMemo, useRef, useState } from 'react';
import { asMap, cardId, defOf, fold, hashing, newId, seedFor, type Card, type GestaltDef, type HostLens, type IndexedNote, type Json, type JsonMap, type NoteSeed, type Repo } from '@gestalts/sdk';
import { attachMedia } from '../widgets/media';
import { finalCards } from '../widgets/draftMerge';
import { withInline } from '../widgets/noteText';
import { addRelation } from '../widgets/relationModel';
import { applyValueDraft, patched } from './valueDraft';

export type SaveState = { saving: boolean; error?: string; conflict?: string[] };

export type NoteDraft = {
  /** the note's key; a new note's, before it's written */
  key: string;
  isNew: boolean;
  /** the note as drafted (or as stored, without edits) */
  value: JsonMap;
  /** what the core makes of `value`: gestalts and lints, live */
  live: IndexedNote;
  dirty: boolean;
  state: SaveState;
  /** sets fields; one set to `undefined` is taken off */
  edit: (patch: Record<string, Json | undefined>) => void;
  /** images and videos for a new note, written once it is */
  staged: File[];
  stage: (files: File[]) => void;
  unstage: (file: File) => void;
  /** writes the draft; resolves to the note's key, or null when nothing was written (no edits, a conflict, an error) */
  commit: (force?: boolean) => Promise<string | null>;
  discard: () => void;
};

const PARTS = ['cards', 'template'] as const;

/**
 * The one draft of a note, new or stored. Edits gather in the draft; `commit` writes them onto the note as it is by
 * then, field by field (`applyValueDraft`), with its inline relationships and embedded blobs brought up to date and
 * cards or a template still in attached notes folded in. A new note is written with its relationship from
 * `relate.from`, then its staged media. After a write, the lenses of the gestalts the note has hear of it.
 */
export function useNoteDraft({ repo, note, seed, lenses, defs, commitOnUnmount }: {
  repo: Repo;
  /** a stored note's edits are written when it goes away (closed, its modal or pane left) */
  commitOnUnmount: boolean;
  /** the stored note; undefined for a new one */
  note: IndexedNote | undefined;
  seed?: NoteSeed;
  lenses: HostLens[];
  defs: GestaltDef[];
}): NoteDraft {
  const [newKey] = useState(newId);
  const key = note?.key ?? newKey;
  const isNew = !note;
  // a new note starts as its seed, with the tags its gestalt requires and what the gestalt's lens adds
  const [seeded] = useState<JsonMap>(() => {
    const value: JsonMap = { id: newKey, ...seed?.value };
    const def = seed?.gestalt ? defOf(defs, seed.gestalt) : undefined;
    if (!def) return value;
    const lens = lenses.find((l) => l.gestalt === seed?.gestalt);
    return lens?.seed ? lens.seed(seedFor(def, value)) : seedFor(def, value);
  });
  const stored = useMemo<JsonMap>(() => (note ? asMap(note.value) ?? {} : seeded), [note, seeded]);
  const [draft, setDraftState] = useState<JsonMap | null>(null);
  const [state, setState] = useState<SaveState>({ saving: false });
  const [staged, setStaged] = useState<File[]>([]);
  // the latest draft and the note when it started, also for a commit in the same event as an edit (a field read on
  // blur, then the note's blur)
  const latest = useRef<{ draft: JsonMap | null; base: JsonMap | null }>({ draft: null, base: null });
  const busy = useRef(false);

  const value = draft ?? stored;
  const live = useMemo(
    () => (draft === null && note ? note : repo.inspect(key, JSON.stringify(draft ?? stored))),
    [draft, note, stored, repo, key],
  );

  const setDraft = (d: JsonMap | null, b: JsonMap | null) => {
    latest.current = { draft: d, base: b };
    setDraftState(d);
  };
  const edit = (patch: Record<string, Json | undefined>) => {
    const cur = latest.current;
    const b = cur.base ?? stored;
    setDraft(patched(cur.draft ?? stored, patch), b);
  };
  const discard = () => { setDraft(null, null); setState({ saving: false }); };

  const notify = async (written: IndexedNote, before: JsonMap | null) => {
    const after = asMap(written.value) ?? {};
    for (const l of lenses.filter((l) => l.afterSave && written.gestalts.includes(l.gestalt))) await l.afterSave!({ key: written.key, before, after });
  };

  const commitNew = async (d: JsonMap): Promise<string | null> => {
    const plan = applyValueDraft({}, {}, withCards(d));
    if (plan.kind !== 'write') return null;
    const value = withInline({ id: newKey, ...plan.value }) as JsonMap;
    const written = await repo.putValue(newKey, value);
    if (seed?.relate) {
      const from = repo.get(seed.relate.from);
      const fromValue = asMap(from?.value);
      if (from && fromValue) await repo.putValue(from.key, addRelation(fromValue, newKey, seed.relate.label ?? null));
    }
    if (staged.length) {
      const r = await attachMedia(repo, newKey, staged);
      if (r.errors.length) throw new Error(`The note was created, but not all of its media: ${r.errors.join(' ')}`);
    }
    await notify(written, null);
    return newKey;
  };

  const commitStored = async (d: JsonMap, b: JsonMap, force: boolean): Promise<string | null> => {
    const host = repo.get(key);
    const current = asMap(host?.value);
    if (!host || !current) throw new Error(host ? 'The note no longer parses; see its source.' : 'The note is gone.');
    const plan = applyValueDraft(current, b, withCards(d), force);
    if (plan.kind === 'conflict') { setState({ saving: false, conflict: plan.keys }); return null; }
    if (!plan.changed.length) { discard(); return key; }
    let next = withInline(plan.value) as JsonMap;
    const retire: fold.FoldWrites['retire'] = [];
    for (const part of PARTS.filter((p) => plan.changed.includes(p))) {
      const attached = fold.attached(repo.query({ tagsAll: [fold.ATTACHED_TAG[part]] }), host.id, part);
      if (!attached.length || next[part] === undefined) continue;
      const writes = fold.foldWrites({ ...host, value: next }, part, next[part], attached, hashing);
      next = writes.host;
      retire.push(...writes.retire);
    }
    const written = await repo.putValue(key, next);
    for (const r of retire) await repo.putValue(r.key, r.value);
    await notify(written, current);
    return key;
  };

  const commit = async (force = false): Promise<string | null> => {
    const { draft: d, base: b } = latest.current;
    if (busy.current) return null;
    if (!isNew && d === null) return key;
    busy.current = true;
    setState({ saving: true });
    try {
      const written = isNew ? await commitNew(d ?? stored) : await commitStored(d!, b ?? stored, force);
      if (written) { setDraft(null, null); setStaged([]); setState({ saving: false }); }
      return written;
    } catch (e) {
      setState({ saving: false, error: e instanceof Error ? e.message : String(e) });
      return null;
    } finally {
      busy.current = false;
    }
  };

  // the latest commit, for the unmount below
  const commitRef = useRef(commit);
  useEffect(() => { commitRef.current = commit; });
  useEffect(() => () => {
    if (commitOnUnmount && !isNew && latest.current.draft !== null) void commitRef.current();
  }, [commitOnUnmount, isNew]);

  return {
    key, isNew, value, live, dirty: draft !== null, state, edit, commit, discard,
    staged, stage: (files) => setStaged((s) => [...s, ...files]), unstage: (f) => setStaged((s) => s.filter((x) => x !== f)),
  };
}

/** Cards as written: empty ones dropped, new ones given ids. */
function withCards(d: JsonMap): JsonMap {
  if (!Array.isArray(d.cards)) return d;
  const cards = d.cards.flatMap((c): Card[] => {
    const m = asMap(c);
    return m ? [{ id: typeof m.id === 'string' ? m.id : '', front: typeof m.front === 'string' ? m.front : '', back: typeof m.back === 'string' ? m.back : '' }] : [];
  });
  return { ...d, cards: finalCards(cards, cardId) };
}
