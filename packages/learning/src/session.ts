import type { Json } from '@gestalts/sdk';

/**
 * One perspective's practice, as `practice-session@1` notes. Pure: times come in as milliseconds, and writes go out
 * through `takeWrites` (see `usePracticeSession`).
 *
 * - Active time: a gap between two activities counts, up to `IDLE_MS`. A gap that began with the page hidden
 *   counts nothing.
 * - A session starts at its first trial, so opening a perspective writes nothing. Its `started` is the first
 *   activity before that trial, and its active time includes the time spent before it.
 * - After a gap of more than `SESSION_GAP_MS` the session is over, and the next trial starts a new note.
 * - `ended` is the last activity, kept current, so a closed tab still leaves a finished session.
 */

export const IDLE_MS = 60_000;
export const SESSION_GAP_MS = 10 * 60_000;

export type SessionEvent = { [k: string]: Json };

type Open = { key: string; started: number; ended: number; active_ms: number; trials: number; events: SessionEvent[]; dirty: boolean };

export class PracticeSession {
  private lastAt: number | null = null;
  private hidden = false;
  private shownAt: number | null = null;
  /** before the first trial: when the activity began, and how much of it counts */
  private pendingStart: number | null = null;
  private pendingActive = 0;
  private current: Open | null = null;
  /** ended sessions with changes not taken yet */
  private closed: Open[] = [];

  constructor(readonly app: string, private newKey: () => string) {}

  /** Any sign of the learner (a key, a tap, the page shown again). */
  activity(now: number) {
    const last = this.lastAt;
    this.lastAt = now;
    const wasHidden = this.hidden;
    this.hidden = false;
    if (last === null) { this.pendingStart ??= now; return; }
    const gap = Math.max(0, now - last);
    if (gap > SESSION_GAP_MS) {
      if (this.current?.dirty) this.closed.push(this.current);
      this.current = null;
      this.shownAt = null;
      this.pendingStart = now;
      this.pendingActive = 0;
      return;
    }
    const add = wasHidden ? 0 : Math.min(gap, IDLE_MS);
    if (this.current) {
      this.current.active_ms += add;
      this.current.ended = now;
      if (add) this.current.dirty = true;
    } else {
      this.pendingStart ??= last;
      this.pendingActive += add;
    }
  }

  /** The page was hidden: time until now counts, the time until it's back doesn't. */
  hide(now: number) {
    this.activity(now);
    this.hidden = true;
  }

  /** Something to answer appeared; the next trial's `ms` is measured from here. */
  shown(now: number) {
    this.activity(now);
    this.shownAt = now;
  }

  /** One answer, rating or attempt; `event` holds the app's own fields (`kind`, …). */
  trial(now: number, event: SessionEvent = {}) {
    this.activity(now);
    if (!this.current) {
      this.current = {
        key: this.newKey(), started: this.pendingStart ?? now, ended: now, active_ms: this.pendingActive, trials: 0, events: [], dirty: true,
      };
      this.pendingStart = null;
      this.pendingActive = 0;
    }
    const e: SessionEvent = { at: new Date(now).toISOString() };
    if (this.shownAt !== null && event.ms === undefined) e.ms = now - this.shownAt;
    this.current.events.push({ ...e, ...event });
    this.current.trials++;
    this.current.ended = now;
    this.current.dirty = true;
    this.shownAt = null;
  }

  /** The notes to write, of sessions changed since the last call. */
  takeWrites(): { key: string; value: Json }[] {
    const changed = [...this.closed, ...(this.current?.dirty ? [this.current] : [])];
    this.closed = [];
    for (const s of changed) s.dirty = false;
    return changed.map((s) => ({ key: s.key, value: this.value(s) }));
  }

  private value(s: Open): Json {
    return {
      id: s.key,
      tags: ['practice-session'],
      app: this.app,
      started: new Date(s.started).toISOString(),
      ended: new Date(s.ended).toISOString(),
      active_ms: Math.round(s.active_ms),
      trials: s.trials,
      events: [...s.events],
    };
  }
}
