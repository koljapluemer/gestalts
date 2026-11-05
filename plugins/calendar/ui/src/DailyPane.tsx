import { useEffect, useRef, useState } from 'react';
import { definePane, definePerspective, stableId, useHost, type Query } from '@gestalts/sdk';
import { Note } from '@gestalts/kit';
import { dailyDate, formatDayHeading, type Day } from './dates';

/** how often an open tab checks whether a new day has begun, in ms */
const TICK_MS = 60_000;

/**
 * The daily note of `date`: the one keyed `stableId("daily", date)`, else another `daily@1` of that date (one keyed
 * otherwise, from elsewhere). Created when there's none, keyed so that two devices creating it make one note.
 */
const Daily = definePerspective<{ days: Query }, { date: Day }>({
  id: 'daily',
  title: 'Daily',
  data: ({ date }) => ({ days: { gestalt: 'daily@1', where: { date } } }),
  Component: ({ data, repo, date }) => {
    const onOpen = useHost().openNote;
    const key = stableId('daily', date);
    const note = data.days.find((n) => n.key === key) ?? data.days[0];
    const [error, setError] = useState<string | null>(null);
    // the date a note was created for, so a render before the query has it doesn't write again
    const created = useRef<Day | null>(null);
    useEffect(() => {
      if (note || created.current === date) return;
      created.current = date;
      repo.putValue(key, { id: key, title: `Daily ${date}`, date, tags: ['daily'] })
        .catch((e: unknown) => { created.current = null; setError(e instanceof Error ? e.message : String(e)); });
    }, [note, date, key, repo]);

    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-3 p-3">
        <h2 className="font-semibold text-primary">{formatDayHeading(date)}</h2>
        {error && <p className="text-sm text-error">{error}</p>}
        {note
          ? <Note key={note.key} noteKey={note.key} defaultMode="edit" persist="daily" tools={{ delete: false }} lenses={['daily@1']} onOpen={onOpen} />
          : !error && <span className="loading loading-spinner loading-sm" />}
      </div>
    );
  },
});

/** Today's daily note, created when missing; a day starts at 04:00, and an open tab moves on to the next one. */
export const DailyPane = definePane({
  title: 'Daily',
  Component: () => {
    const [date, setDate] = useState(dailyDate);
    useEffect(() => {
      const timer = setInterval(() => setDate(dailyDate()), TICK_MS);
      return () => clearInterval(timer);
    }, []);
    return <Daily date={date} />;
  },
});
