import { useState } from 'react';
import { noteLabel, str, useHost, type IndexedNote } from '@gestalts/sdk';
import { NoteLine } from '@gestalts/kit';
import { appointmentOn, ongoing, recursOn, weekdayName, type Day } from './dates';

/** What the calendar shows: `appointment@1` and `recurring@1` notes. */
export type Entries = { appointments: IndexedNote[]; recurring: IndexedNote[] };

const byLabel = (a: IndexedNote, b: IndexedNote) => noteLabel(a).localeCompare(noteLabel(b));

/** The appointments on `day` and the recurring items falling on it, by label. */
export const entriesOn = ({ appointments, recurring }: Entries, day: Day) => [
  ...appointments.filter((n) => appointmentOn(str(n, 'date'), day)),
  ...recurring.filter((n) => recursOn(str(n, 'weekday'), str(n, 'until'), day)),
].sort(byLabel);

/** Appointments longer than a day (a month, a range) overlapping `from..to`, by label. */
export const ongoingIn = ({ appointments }: Entries, from: Day, to: Day) =>
  appointments.filter((n) => ongoing(str(n, 'date'), from, to)).sort(byLabel);

/** One item in a list: its label, opened in the host's editor; a recurring one says when, a longer one its dates. */
export function Entry({ note, showDate }: { note: IndexedNote; showDate?: boolean }) {
  const open = useHost().openNote;
  const weekday = str(note, 'weekday');
  const badge = weekday
    ? `every ${weekdayName(weekday)}${str(note, 'until') ? ` until ${str(note, 'until')}` : ''}`
    : showDate ? str(note, 'date') : undefined;
  const body = <>
    <span className="min-w-0 flex-1"><NoteLine note={note} /></span>
    {badge && <span className="badge badge-sm badge-ghost shrink-0">{badge}</span>}
  </>;
  return open
    ? <button type="button" className="flex w-full items-center gap-2 border-b border-base-300 py-2 text-left hover:bg-base-200" onClick={() => open(note.key)}>{body}</button>
    : <div className="flex items-center gap-2 border-b border-base-300 py-2">{body}</div>;
}

/** The "Ongoing" strip: longer appointments, once rather than on every day. */
export function Ongoing({ notes }: { notes: IndexedNote[] }) {
  if (!notes.length) return null;
  return (
    <section className="mb-3 rounded-box bg-base-200 px-3 py-1">
      <h3 className="pt-1 text-xs text-base-content/60">Ongoing</h3>
      {notes.map((n) => <Entry key={n.key} note={n} showDate />)}
    </section>
  );
}

/** A new appointment's title, written on Enter; Escape or an empty title cancels. */
export function AddAppointment({ onAdd, onCancel }: { onAdd: (title: string) => Promise<void>; onCancel: () => void }) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (!title.trim()) { onCancel(); return; }
    onAdd(title.trim()).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <div className="py-2">
      <input autoFocus className="input input-sm w-full" placeholder="New appointment (Enter adds, Esc cancels)" value={title}
             onChange={(e) => setTitle(e.target.value)} onBlur={() => { if (!title.trim()) onCancel(); }}
             onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onCancel(); }} />
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}
