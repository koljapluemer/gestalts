import { noteLabel, str, useHost, type IndexedNote } from '@gestalts/sdk';
import { Note } from '@gestalts/kit';
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

/** One item in a list: the note in one line, opened in the host's editor; a recurring one says when, a longer one its dates. */
export function Entry({ note, showDate }: { note: IndexedNote; showDate?: boolean }) {
  const open = useHost().openNote;
  const weekday = str(note, 'weekday');
  const badge = weekday
    ? `every ${weekdayName(weekday)}${str(note, 'until') ? ` until ${str(note, 'until')}` : ''}`
    : showDate ? str(note, 'date') : undefined;
  return (
    <div className="flex items-center gap-2 border-b border-base-300 py-1.5">
      <Note noteKey={note.key} render="inline" onOpen={open} tools={{ delete: false }} className="min-w-0 flex-1" />
      {badge && <span className="badge badge-sm badge-ghost shrink-0">{badge}</span>}
    </div>
  );
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
