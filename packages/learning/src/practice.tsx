import { useCallback, useEffect, useMemo, useState } from 'react';
import { logger, newId, stateKey, useRepo, type Repo } from '@gestalts/sdk';
import { fsrsStateValue, isAhead, withLocal, type Facet, type FsrsStates, type LocalReview, type ReviewState } from './learning';
import { PracticeSession, type SessionEvent } from './session';

const plog = logger('practice');

/** What a perspective logs its practice with; see `PracticeSession`. */
export type PracticeLog = {
  /** something to answer appeared (measures the next trial's `ms`) */
  shown(): void;
  /** one answer; writes the session note */
  trial(event?: SessionEvent): Promise<void>;
};

/**
 * The practice log of perspective `app`: `practice-session@1` notes, one per session, written by this page only.
 * Activity is any key or pointer press on the page while it's visible.
 */
export function usePracticeSession(app: string): PracticeLog {
  const repo = useRepo();
  const [session] = useState(() => new PracticeSession(app, newId));

  useEffect(() => {
    const flush = () => { for (const w of session.takeWrites()) void repo.putValue(w.key, w.value); };
    const act = () => session.activity(Date.now());
    const visibility = () => {
      if (document.visibilityState === 'hidden') { session.hide(Date.now()); flush(); } else act();
    };
    window.addEventListener('pointerdown', act, true);
    window.addEventListener('keydown', act, true);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('pointerdown', act, true);
      window.removeEventListener('keydown', act, true);
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', visibility);
      session.activity(Date.now());
      flush();
    };
  }, [repo, session]);

  return useMemo(() => ({
    shown: () => session.shown(Date.now()),
    trial: async (event?: SessionEvent) => {
      session.trial(Date.now(), event);
      await Promise.all(session.takeWrites().map((w) => repo.putValue(w.key, w.value)));
    },
  }), [repo, session]);
}

/**
 * The FSRS states to practice with: `stored` (from the query) with the reviews made here laid over it until the
 * query has them. So the next card can be picked at once, while the save runs in the background (or waits behind a
 * sync). `put` adds a review.
 */
export function useLocalReviews(stored: FsrsStates): { states: FsrsStates; put: (facet: Facet, state: ReviewState) => void } {
  const [local, setLocal] = useState<LocalReview[]>([]);
  const states = useMemo(() => withLocal(stored, local), [stored, local]);
  const put = useCallback((facet: Facet, state: ReviewState) => {
    const slot = (f: Facet) => `${f.target}\u0000${f.facet ?? ''}`;
    // also drops the ones the query has caught up with
    setLocal((l) => [...l.filter((r) => slot(r.facet) !== slot(facet) && isAhead(stored, r)), { facet, state }]);
  }, [stored]);
  return { states, put };
}

/**
 * Saves `next` as the FSRS state of `f` (under `prev`'s key if it has one, else `stateKey`) and, with a `log`,
 * records an `fsrs-review` trial. Returns `next` with its saved key.
 *
 * The trial is recorded synchronously, before the first await: its `ms` counts from when this card was shown, so it
 * must be taken before the next card is.
 */
export async function saveReview(repo: Repo, f: Facet, prev: ReviewState | undefined, next: ReviewState, log?: PracticeLog): Promise<ReviewState> {
  const key = prev?.key ?? stateKey('fsrs-state', f.target, f.facet);
  const span = plog.span('saveReview', { target: f.target, facet: f.facet, key, rating: next.lastRating, dueAt: next.card.dueAt });
  const trial = log?.trial({ kind: 'fsrs-review', target: f.target, ...(f.facet ? { facet: f.facet } : {}), rating: next.lastRating });
  // handled where it's awaited below; this keeps a failure meanwhile from counting as unhandled
  trial?.catch(() => {});
  try {
    const saved = await repo.putValue(key, fsrsStateValue(key, f, next));
    await trial;
    span.end();
    return { ...next, key: saved.key };
  } catch (e) {
    span.fail(e);
    throw e;
  }
}
