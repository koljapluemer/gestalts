import { Plus } from 'lucide-react';
import { daysBetween, formatDayHeading, isDay, today, type Day } from './dates';
import { Entry, Ongoing, entriesOn, ongoingIn, type Entries } from './items';

type Props = {
  entries: Entries;
  from: Day;
  to: Day;
  onRange: (from: Day, to: Day) => void;
  /** a new appointment on `day` */
  onAdd: (day: Day) => void;
};

/** Every day of From..To (inclusive) with its items, empty days included. */
export function RangeView({ entries, from, to, onRange, onAdd }: Props) {
  const now = today();
  // a From after To drags To along, and the other way round, so the range is never empty
  const pickFrom = (d: string) => { if (isDay(d)) onRange(d, d > to ? d : to); };
  const pickTo = (d: string) => { if (isDay(d)) onRange(d < from ? d : from, d); };
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-2">
        <label className="input input-sm flex-1"><span className="label">From</span>
          <input type="date" value={from} onChange={(e) => pickFrom(e.target.value)} />
        </label>
        <label className="input input-sm flex-1"><span className="label">To</span>
          <input type="date" value={to} onChange={(e) => pickTo(e.target.value)} />
        </label>
      </div>
      <Ongoing notes={ongoingIn(entries, from, to)} />
      {daysBetween(from, to).map((day) => {
        const items = entriesOn(entries, day);
        return (
          <section key={day} className="mt-4">
            <div className="flex items-center border-b border-base-300 pb-1">
              <h3 className={`flex-1 font-medium ${day === now ? 'font-bold text-primary' : ''}`}>
                {day === now ? `Today — ${formatDayHeading(day)}` : formatDayHeading(day)}
              </h3>
              <button type="button" className="btn btn-square btn-ghost btn-xs" title="add an appointment" onClick={() => onAdd(day)}><Plus className="size-3.5" /></button>
            </div>
            {!items.length && <p className="py-2 text-base-content/50">Nothing</p>}
            {items.map((n) => <Entry key={n.key} note={n} />)}
          </section>
        );
      })}
    </div>
  );
}
