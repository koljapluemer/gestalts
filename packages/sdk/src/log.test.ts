import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPACITY, debugLog, logger } from './log';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  debugLog.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('debug log', () => {
  it('keeps the newest events, oldest first, up to its capacity', () => {
    const log = logger('t');
    for (let i = 0; i < CAPACITY + 5; i++) log.debug(`e${i}`);
    const events = debugLog.events();
    expect(events).toHaveLength(CAPACITY);
    expect(events[0].msg).toBe('e5');
    expect(events.at(-1)?.msg).toBe(`e${CAPACITY + 4}`);
  });

  it('times a span', () => {
    const s = logger('t').span('work', { key: 'k' });
    vi.advanceTimersByTime(150);
    s.end({ n: 1 });
    expect(debugLog.events().at(-1)).toMatchObject({ scope: 't', level: 'debug', msg: 'work: end', data: { key: 'k', n: 1, ms: 150 } });
    expect(debugLog.snapshot().open).toEqual([]);
  });

  it('reports a span still open after 2 s, and lists it', () => {
    logger('repo').span('putValue', { key: 'k' });
    vi.advanceTimersByTime(2500);
    expect(debugLog.events().filter((e) => e.level === 'warn').map((e) => e.msg)).toEqual(['putValue: still running after 2s']);
    expect(debugLog.snapshot().open).toMatchObject([{ scope: 'repo', msg: 'putValue', data: { key: 'k' } }]);
    vi.advanceTimersByTime(8000);
    expect(debugLog.summary()).toMatchObject({ open: 1, warnings: 2 });
  });

  it('logs a failed span as an error, with the error as plain data', () => {
    logger('t').span('work').fail(new TypeError('boom'));
    const e = debugLog.events().at(-1)!;
    expect(e.level).toBe('error');
    expect(e.data?.error).toMatchObject({ name: 'TypeError', message: 'boom' });
    expect(() => JSON.stringify(debugLog.snapshot())).not.toThrow();
  });

  it('cuts long strings', () => {
    logger('t').info('big', { text: 'x'.repeat(5000) });
    expect(String(debugLog.events().at(-1)?.data?.text).length).toBeLessThan(600);
  });

  it('works when localStorage throws', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); } });
    debugLog.reloadScopes();
    expect(() => logger('t').info('ok')).not.toThrow();
    vi.unstubAllGlobals();
  });
});
