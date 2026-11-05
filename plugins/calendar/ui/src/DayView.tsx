import { ChevronLeft, ChevronRight, Plus, Repeat } from 'lucide-react';
import { WEEKDAY_CODES, addDays, formatDayHeading, isDay, today, weekday, weekdayName, type Day } from './dates';
import { Entry, Ongoing, entriesOn, ongoingIn, type Entries } from './items';

type Props = {
  entries: Entries;
  day: Day;
  onDay: (day: Day) => void;
  /** a new appointment on `day` */
  onAdd: (day: Day) => void;
  /** a new recurring item, on `day`'s weekday */
  onAddRecurring: (code: string) => void;
};

/** The items of one day; the bar steps a day back or forward, picks a date, or jumps back to today. */
export function DayView({ entries, day, onDay, onAdd, onAddRecurring }: Props) {
  const now = today();
  const items = entriesOn(entries, day);
  const code = WEEKDAY_CODES[weekday(day) - 1];
  return (
    <div>
      <div className="mb-2 flex items-center gap-1">
        <button type="button" className="btn btn-square btn-ghost btn-sm" title="previous day (←)" onClick={() => onDay(addDays(day, -1))}><ChevronLeft className="size-5" /></button>
        <input type="date" className="input input-sm flex-1" value={day} onChange={(e) => { if (isDay(e.target.value)) onDay(e.target.value); }} />
        <button type="button" className="btn btn-ghost btn-sm" title="t" disabled={day === now} onClick={() => onDay(now)}>Today</button>
        <button type="button" className="btn btn-square btn-ghost btn-sm" title="next day (→)" onClick={() => onDay(addDays(day, 1))}><ChevronRight className="size-5" /></button>
        <button type="button" className="btn btn-square btn-sm" title="add an appointment (a)" onClick={() => onAdd(day)}><Plus className="size-5" /></button>
        <button type="button" className="btn btn-square btn-ghost btn-sm" title={`add something every ${weekdayName(code)}`} onClick={() => onAddRecurring(code)}><Repeat className="size-4" /></button>
      </div>
      <Ongoing notes={ongoingIn(entries, day, day)} />
      <h3 className={`border-b border-base-300 pb-1 font-medium ${day === now ? 'font-bold text-primary' : ''}`}>
        {day === now ? `Today — ${formatDayHeading(day)}` : formatDayHeading(day)}
      </h3>
      {!items.length && <p className="my-8 text-center text-base-content/50">Nothing on this day</p>}
      {items.map((n) => <Entry key={n.key} note={n} />)}
    </div>
  );
}
