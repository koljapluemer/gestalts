/** Calendar days are ISO `YYYY-MM-DD` strings; they compare and sort as strings. */
export type Day = string;

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `recurring@1`'s `weekday` values, Monday first */
export const WEEKDAY_CODES = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'] as const;

/** a new day starts at this local hour, not at midnight */
export const DAY_STARTS_AT = 4;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const fromDate = (d: Date): Day => `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** local midnight, built from components so DST can't shift the day */
const toDate = (day: Day) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d); };

export const isDay = (s: unknown): s is Day => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fromDate(toDate(s)) === s;

export const today = (): Day => fromDate(new Date());

/** The day `now` counts as for the daily note: before DAY_STARTS_AT it's still the day before. */
export const dailyDate = (now = new Date()): Day =>
  fromDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getHours() < DAY_STARTS_AT ? 1 : 0)));

export const addDays = (day: Day, n: number): Day => { const d = toDate(day); return fromDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)); };

/** 1 = Mon .. 7 = Sun */
export const weekday = (day: Day) => toDate(day).getDay() || 7;

/** The Sunday on or before `day`: weeks start on Sunday. */
export const startOfWeek = (day: Day) => addDays(day, -(weekday(day) % 7));

/** `from` to `to`, inclusive. */
export function daysBetween(from: Day, to: Day): Day[] {
  const out: Day[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** e.g. `Fri, 29 Aug 2026` */
export const formatDayHeading = (day: Day) => `${WEEKDAYS[weekday(day) - 1]}, ${formatShortDate(day)}`;

/** e.g. `29 Aug 2026` */
export const formatShortDate = (day: Day) => { const [y, m, d] = day.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

/** e.g. `Tue` for `tu` */
export const weekdayName = (code: string) => WEEKDAYS[WEEKDAY_CODES.indexOf(code as (typeof WEEKDAY_CODES)[number])] ?? code;

/** The first and last day a partial date covers (`2026`, `2026-11`, `2026-11-05`), or null. */
function bounds(s: string): [Day, Day] | null {
  if (/^\d{4}$/.test(s)) return [`${s}-01-01`, `${s}-12-31`];
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) {
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return [`${s}-01`, addDays(fromDate(new Date(Number(m[1]), month, 1)), -1)];
  }
  return isDay(s) ? [s, s] : null;
}

/** The days a partial date or range (`a/b`, either end may be open) covers; null ends are open. */
export type Span = { from: Day | null; to: Day | null };

export function span(s: string | undefined): Span | null {
  if (!s) return null;
  const slash = s.indexOf('/');
  if (slash < 0) {
    const b = bounds(s);
    return b && { from: b[0], to: b[1] };
  }
  const [a, z] = [s.slice(0, slash), s.slice(slash + 1)];
  if (!a && !z) return null;
  const ba = a ? bounds(a) : null;
  const bz = z ? bounds(z) : null;
  if ((a && !ba) || (z && !bz)) return null;
  return { from: ba?.[0] ?? null, to: bz?.[1] ?? null };
}

/** A span of exactly one day: its day. */
export const singleDay = (sp: Span | null): Day | null => (sp && sp.from && sp.from === sp.to ? sp.from : null);

/** An appointment's `date` is that one `day`. */
export const appointmentOn = (date: string | undefined, day: Day) => singleDay(span(date)) === day;

/** A longer appointment (a month, a range) that overlaps `from..to`. */
export function ongoing(date: string | undefined, from: Day, to: Day): boolean {
  const sp = span(date);
  if (!sp || singleDay(sp)) return false;
  return (sp.from === null || sp.from <= to) && (sp.to === null || sp.to >= from);
}

/** A recurring item (`weekday`, optional `until`) falls on `day`. */
export function recursOn(code: string | undefined, until: string | undefined, day: Day): boolean {
  if (WEEKDAY_CODES[weekday(day) - 1] !== code) return false;
  const end = span(until)?.to;
  return !end || day <= end;
}

/** An appointment over before `day` (a month-only date once the month is over; an open end never is). */
export function isPast(date: string | undefined, day: Day): boolean {
  const end = span(date)?.to;
  return !!end && end < day;
}
