import { useState } from 'react';
import { GitMerge } from 'lucide-react';
import { conflicts as listConflicts, pathLabel, resolveConflict, useQuery, useRepo, type ConflictRecord, type Json, type Resolution } from '@gestalts/sdk';

type Props = {
  /** only the conflicts in this note; else all of them */
  noteKey?: string;
  /** a note's key was clicked */
  onOpen?: (key: string) => void;
};

const QUERY = { gestalt: 'conflict@1' };

/**
 * Conflicts a sync couldn't settle (`conflict@1` notes): the value the note kept and the other side's, to keep one
 * of, or (for text) to edit. Shows nothing without conflicts.
 */
export function Conflicts({ noteKey, onOpen }: Props) {
  const repo = useRepo();
  useQuery(QUERY); // re-render when conflicts come and go
  const list = listConflicts(repo, noteKey);
  if (!list.length) return null;
  return (
    <div role="alert" className="alert alert-warning alert-soft flex flex-col items-stretch gap-2 text-sm">
      <p className="flex items-center gap-2 font-semibold">
        <GitMerge className="size-4" />
        {list.length === 1 ? 'A conflicting edit' : `${list.length} conflicting edits`} from syncing
      </p>
      {list.map((c) => <ConflictRow key={c.key} c={c} showNote={!noteKey} onOpen={onOpen} />)}
    </div>
  );
}

function ConflictRow({ c, showNote, onOpen }: { c: ConflictRecord; showNote: boolean; onOpen?: (key: string) => void }) {
  const repo = useRepo();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const deletion = isTombstone(c.kept);
  const resolve = async (how: Resolution) => {
    setBusy(true);
    try { await resolveConflict(repo, c, how); } finally { setBusy(false); }
  };
  const textual = typeof c.kept === 'string' || typeof c.lost === 'string';
  return (
    <div className="flex flex-col gap-1 rounded-box bg-base-100 p-2 text-base-content">
      <p className="text-xs">
        {showNote && (onOpen
          ? <button type="button" className="link font-mono" onClick={() => onOpen(c.note)}>{c.note}</button>
          : <code>{c.note}</code>)}
        {showNote && ' · '}
        {deletion ? 'deleted on one side, edited on the other' : <>at <code>{pathLabel(c.path)}</code></>}
      </p>
      {editing === null ? (
        <div className="grid gap-1 sm:grid-cols-2">
          <Side label={deletion ? 'Now: deleted' : 'Now'} value={deletion ? undefined : c.kept} />
          <Side label={deletion ? 'The edit' : 'The other side'} value={c.lost} />
        </div>
      ) : (
        <textarea className="textarea textarea-sm h-28 w-full font-mono" value={editing} onChange={(e) => setEditing(e.target.value)} aria-label="Merged value" />
      )}
      <div className="flex flex-wrap justify-end gap-1">
        {editing === null ? (
          <>
            {textual && !c.raw && !deletion && (
              <button type="button" className="btn btn-xs btn-ghost" disabled={busy} onClick={() => setEditing(typeof c.kept === 'string' ? c.kept : '')}>Edit</button>
            )}
            <button type="button" className="btn btn-xs" disabled={busy} onClick={() => void resolve({ take: 'lost' })}>{deletion ? 'Restore the edit' : 'Use the other side'}</button>
            <button type="button" className="btn btn-xs btn-primary" disabled={busy} onClick={() => void resolve({ take: 'kept' })}>{deletion ? 'Keep it deleted' : 'Keep this'}</button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-xs btn-ghost" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
            <button type="button" className="btn btn-xs btn-primary" disabled={busy} onClick={() => void resolve({ value: editing })}>Save</button>
          </>
        )}
      </div>
    </div>
  );
}

function Side({ label, value }: { label: string; value: Json | undefined }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-base-content/60">{label}</p>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-base-200 p-1 text-xs">{show(value)}</pre>
    </div>
  );
}

function show(v: Json | undefined): string {
  if (v === undefined) return '(none)';
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

function isTombstone(v: Json | undefined): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && 'deleted' in v && Object.keys(v).every((k) => k === 'id' || k === 'deleted');
}
