import { describe, expect, it } from 'vitest';
import { addDays, appointmentOn, dailyDate, daysBetween, formatDayHeading, isDay, isPast, ongoing, recursOn, span, startOfWeek, weekday } from './dates';

describe('dates', () => {
  it('steps across months, years and DST', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-03-28', 2)).toBe('2026-03-30');
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26');
  });

  it('starts weeks on Sunday', () => {
    expect(weekday('2026-08-29')).toBe(6);
    expect(startOfWeek('2026-08-29')).toBe('2026-08-23');
    expect(startOfWeek('2026-08-23')).toBe('2026-08-23');
    expect(daysBetween('2026-08-30', '2026-09-01')).toEqual(['2026-08-30', '2026-08-31', '2026-09-01']);
  });

  it('formats and validates', () => {
    expect(formatDayHeading('2026-08-29')).toBe('Sat, 29 Aug 2026');
    expect(isDay('2026-02-29')).toBe(false);
    expect(isDay('2028-02-29')).toBe(true);
  });
});

describe('dailyDate', () => {
  it('starts the day at 4am', () => {
    expect(dailyDate(new Date(2026, 9, 28, 3, 59))).toBe('2026-10-27');
    expect(dailyDate(new Date(2026, 9, 28, 4, 0))).toBe('2026-10-28');
    expect(dailyDate(new Date(2026, 9, 28, 23, 59))).toBe('2026-10-28');
  });

  it('steps back over month and year ends', () => {
    expect(dailyDate(new Date(2026, 2, 1, 1))).toBe('2026-02-28');
    expect(dailyDate(new Date(2027, 0, 1, 0, 30))).toBe('2026-12-31');
  });
});

describe('partial dates', () => {
  it('expands to the days they cover', () => {
    expect(span('2026-11-05')).toEqual({ from: '2026-11-05', to: '2026-11-05' });
    expect(span('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(span('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(span('2026')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(span('2026-11-05/2026-12')).toEqual({ from: '2026-11-05', to: '2026-12-31' });
    expect(span('2026-11/')).toEqual({ from: '2026-11-01', to: null });
    expect(span('/2026')).toEqual({ from: null, to: '2026-12-31' });
    for (const bad of ['', '/', '2026-13', '2026-02-30', 'soon', '26-11-05']) expect(span(bad)).toBeNull();
  });

  it('places appointments', () => {
    expect(appointmentOn('2026-08-29', '2026-08-29')).toBe(true);
    expect(appointmentOn('2026-08-29', '2026-08-30')).toBe(false);
    expect(appointmentOn('2026-08-29/2026-08-29', '2026-08-29')).toBe(true);
    expect(appointmentOn('2026-08', '2026-08-29')).toBe(false);
    expect(ongoing('2026-08', '2026-08-29', '2026-08-29')).toBe(true);
    expect(ongoing('2026-08', '2026-09-01', '2026-09-07')).toBe(false);
    expect(ongoing('2026-08-30/', '2026-09-01', '2026-09-07')).toBe(true);
    expect(ongoing('2026-08-29', '2026-08-29', '2026-08-29')).toBe(false);
  });

  it('places recurring items', () => {
    expect(recursOn('mo', '2026-03-30', '2026-03-30')).toBe(true);
    expect(recursOn('mo', '2026-03-30', '2026-04-06')).toBe(false);
    expect(recursOn('mo', '2026-04', '2026-04-27')).toBe(true);
    expect(recursOn('su', undefined, '2026-08-23')).toBe(true);
    expect(recursOn('mo', undefined, '2026-08-23')).toBe(false);
  });

  it('knows what is past', () => {
    expect(isPast('2026-11-04', '2026-11-05')).toBe(true);
    expect(isPast('2026-11-05', '2026-11-05')).toBe(false);
    expect(isPast('2026-10', '2026-11-01')).toBe(true);
    expect(isPast('2026-11', '2026-11-05')).toBe(false);
    expect(isPast('2026-01/', '2027-01-01')).toBe(false);
    expect(isPast('broken', '2027-01-01')).toBe(false);
  });
});
