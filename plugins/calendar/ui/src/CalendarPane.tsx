import { useEffect, useState } from 'react';
import { definePane, definePerspective, noteLabel, str, useHost, type IndexedNote, type Query, type Repo } from '@gestalts/sdk';
import { setUrlParams, useUrlList } from '@gestalts/kit';
import { addDays, daysBetween, isDay, isPast, startOfWeek, today, type Day } from './dates';
import { DayView } from './DayView';
import { RangeView } from './RangeView';
import { Entry } from './items';

/** A key press meant for the calendar, not for a field or an open dialog. */
function forCalendar(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  const typing = t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
  return !typing && !e.metaKey && !e.ctrlKey && !e.altKey && !document.querySelector('dialog[open]');
}

/** One URL param holding a day, ignored when it isn't one. */
function useUrlDay(name: string): Day | undefined {
  const [[v] = []] = useUrlList(name);
  return isDay(v) ? v : undefined;
}

/**
 * Appointments and recurring items, by day or over a From..To range (this week, Sunday to Saturday, by default);
 * view, day and range are in the URL. Items open in the host's editor; `+` adds an appointment on that day. Below,
 * the appointments that are over, to delete.
 */
const Calendar = definePerspective<{ appointments: Query; recurring: Query }>({
  id: 'calendar',
  title: 'Calendar',
  data: { appointments: { gestalt: 'appointment@1' }, recurring: { gestalt: 'recurring@1' } },
  Component: ({ data, repo }) => {
    const [[view] = []] = useUrlList('view');
    const range = view === 'range';
    const now = today();
    const day = useUrlDay('day') ?? now;
    const from = useUrlDay('from') ?? startOfWeek(now);
    const to = useUrlDay('to') ?? addDays(from, 6);
    const host = useHost();

    const setDay = (d: Day) => setUrlParams({ day: d === now ? null : d });
    const setView = (v: 'day' | 'range') => setUrlParams({ view: v === 'range' ? 'range' : null });
    // the host's new note, with the appointment's fields and its date set
    const add = (d: Day) => void host.createNote?.({ gestalt: 'appointment@1', value: { date: d }, preset: 'gestalt' });
    const addRecurring = (weekday: string) => void host.createNote?.({ gestalt: 'recurring@1', value: { weekday }, preset: 'gestalt' });
    // a day back or forward, or the range by its own length
    const step = (n: number) => {
      if (!range) { setDay(addDays(day, n)); return; }
      const len = daysBetween(from, to).length;
      setUrlParams({ from: addDays(from, n * len), to: addDays(to, n * len) });
    };

    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (!forCalendar(e)) return;
        const run = ({
          ArrowLeft: () => step(-1),
          ArrowRight: () => step(1),
          t: () => setUrlParams({ day: null, from: null, to: null }),
          a: () => { if (!range) add(day); },
          d: () => setView('day'),
          r: () => setView('range'),
        } as Record<string, (() => void) | undefined>)[e.key];
        if (run) { e.preventDefault(); run(); }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    });

    return (
      <div className="mx-auto flex max-w-3xl flex-col p-3">
        <div className="join mb-4">
          <button type="button" className={`btn btn-sm join-item ${range ? '' : 'btn-active'}`} title="d" onClick={() => setView('day')}>Day</button>
          <button type="button" className={`btn btn-sm join-item ${range ? 'btn-active' : ''}`} title="r" onClick={() => setView('range')}>Range</button>
        </div>
        {range
          ? <RangeView entries={data} from={from} to={to} onRange={(f, t) => setUrlParams({ from: f, to: t })} onAdd={add} />
          : <DayView entries={data} day={day} onDay={setDay} onAdd={add} onAddRecurring={addRecurring} />}
        <PastAppointments repo={repo} notes={data.appointments.filter((n) => isPast(str(n, 'date'), now))} />
      </div>
    );
  },
});

/** Appointments over before today, listed and deleted together (recurring and undated ones never are). */
function PastAppointments({ repo, notes }: { repo: Repo; notes: IndexedNote[] }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!notes.length) return null;
  const sorted = [...notes].sort((a, b) => (str(a, 'date') ?? '').localeCompare(str(b, 'date') ?? '') || noteLabel(a).localeCompare(noteLabel(b)));
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const n of sorted) await repo.delete(n.key);
      setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  return (
    <details className="mt-8 text-sm">
      <summary className="cursor-pointer text-base-content/60">Past appointments ({notes.length})</summary>
      <div className="mt-2 flex items-center gap-2">
        {confirming
          ? <>
            <button type="button" className="btn btn-sm btn-error" disabled={busy} onClick={() => void remove()}>Delete {notes.length}, for good</button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
          </>
          : <button type="button" className="btn btn-sm" onClick={() => setConfirming(true)}>Delete all {notes.length}</button>}
        {busy && <span className="loading loading-spinner loading-xs" />}
      </div>
      {error && <p className="text-xs text-error">{error}</p>}
      <div className="mt-2">{sorted.map((n) => <Entry key={n.key} note={n} showDate />)}</div>
    </details>
  );
}

export const CalendarPane = definePane({ title: 'Calendar', Component: () => <Calendar /> });
