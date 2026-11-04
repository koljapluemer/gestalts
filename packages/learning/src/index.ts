/** Learning for plugins (`@gestalts/learning`): FSRS by facet, practice sessions, learnable cards. */
export { MODEL as FSRS_MODEL, Rating, fsrsStates, fsrsStateValue, getScheduler, isAhead, review, stateFromNote, withLocal, type Facet, type LocalReview, type FsrsStates, type Grade, type ReviewState, type Scheduler } from './learning';
export { learnableCards, pickNext, slotOf, until, type LearnCard, type Pick as LearnPick } from './learn';
export { IDLE_MS, SESSION_GAP_MS, PracticeSession, type SessionEvent } from './session';
export { usePracticeSession, useLocalReviews, saveReview, type PracticeLog } from './practice';
