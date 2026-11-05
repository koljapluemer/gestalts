import { defineLens, type FieldProps } from '@gestalts/sdk';
import { formatDayHeading, formatShortDate, isDay, weekdayName } from './dates';

const text = (v: unknown) => (typeof v === 'string' ? v : '');

/** An appointment's date: a day picked, or typed as a month, a year or a range (`from/to`). */
function DateField({ value, onChange }: FieldProps) {
  const v = text(value);
  if (!onChange) return <span>{isDay(v) ? formatDayHeading(v) : v || '—'}</span>;
  return (
    <div className="flex flex-wrap gap-1">
      <input type="date" className="input input-sm w-auto" aria-label="day" value={isDay(v) ? v : ''} onChange={(e) => onChange(e.target.value || undefined)} />
      <input className="input input-sm min-w-32 flex-1" aria-label="or a month, a year or a range" placeholder="or YYYY-MM, YYYY, from/to"
             value={v} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

export const AppointmentLens = defineLens({
  gestalt: 'appointment@1',
  title: 'Appointment',
  priority: 1,
  fields: { date: { label: 'when', Field: DateField } },
  Summary: ({ note }) => {
    const v = text(note.date);
    return v ? <span className="badge badge-sm badge-ghost shrink-0">{isDay(v) ? formatShortDate(v) : v}</span> : null;
  },
});

export const RecurringLens = defineLens({
  gestalt: 'recurring@1',
  title: 'Recurring',
  priority: 1,
  fields: { weekday: { label: 'every', order: 0 }, until: { label: 'until', order: 1 } },
  Summary: ({ note }) => {
    const w = text(note.weekday);
    return w ? <span className="badge badge-sm badge-ghost shrink-0">every {weekdayName(w)}</span> : null;
  },
});

/** A daily note's date is its key's: shown, not edited. */
export const DailyLens = defineLens({
  gestalt: 'daily@1',
  title: 'Daily',
  fields: { date: { label: 'day', Field: ({ value }) => <span>{isDay(text(value)) ? formatDayHeading(text(value)) : text(value)}</span> } },
});
