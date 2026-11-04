import { describe, expect, it } from 'vitest';
import { IDLE_MS, PracticeSession, SESSION_GAP_MS } from './session';

const t0 = Date.parse('2026-11-03T10:00:00.000Z');
const s = (n: number) => t0 + n * 1000;

function session() {
  let n = 0;
  return new PracticeSession('test-app', () => `key-${++n}`);
}

describe('PracticeSession', () => {
  it('writes nothing before the first trial', () => {
    const p = session();
    p.activity(s(0));
    p.activity(s(10));
    p.hide(s(20));
    expect(p.takeWrites()).toEqual([]);
  });

  it('starts at the first activity and counts the time before the first trial', () => {
    const p = session();
    p.activity(s(0));
    p.shown(s(5));
    p.trial(s(12), { kind: 'x' });
    const [w] = p.takeWrites();
    expect(w.key).toBe('key-1');
    expect(w.value).toEqual({
      id: 'key-1', tags: ['practice-session'], app: 'test-app',
      started: new Date(s(0)).toISOString(), ended: new Date(s(12)).toISOString(),
      active_ms: 12_000, trials: 1, events: [{ at: new Date(s(12)).toISOString(), ms: 7000, kind: 'x' }],
    });
    // nothing changed since
    expect(p.takeWrites()).toEqual([]);
  });

  it('caps idle gaps and does not count hidden time', () => {
    const p = session();
    p.trial(s(0));
    p.trial(s(300)); // 5 min without a sign: counts IDLE_MS
    p.hide(s(310));
    p.activity(s(500)); // hidden: counts nothing
    p.trial(s(502));
    const [w] = p.takeWrites();
    expect(w.value).toMatchObject({ active_ms: IDLE_MS + 10_000 + 2000, trials: 3, ended: new Date(s(502)).toISOString() });
  });

  it('starts a new note after a long gap, writing the end of the old one', () => {
    const p = session();
    p.trial(s(0));
    p.takeWrites();
    p.activity(s(30)); // after the last write
    const resume = s(30) + SESSION_GAP_MS + 1;
    p.trial(resume);
    const writes = p.takeWrites();
    expect(writes.map((w) => w.key)).toEqual(['key-1', 'key-2']);
    expect(writes[0].value).toMatchObject({ active_ms: 30_000, trials: 1, ended: new Date(s(30)).toISOString() });
    expect(writes[1].value).toMatchObject({ active_ms: 0, trials: 1, started: new Date(resume).toISOString() });
  });

  it('keeps the caller’s ms and does not reuse a shown time', () => {
    const p = session();
    p.shown(s(0));
    p.trial(s(4), { ms: 1 });
    p.trial(s(6));
    const events = (p.takeWrites()[0].value as { events: object[] }).events;
    expect(events).toEqual([{ at: new Date(s(4)).toISOString(), ms: 1 }, { at: new Date(s(6)).toISOString() }]);
  });
});
