/** Learning for views (`@gestalts/learning`): FSRS by facet, practice sessions and events, picking what comes next, and using what the app believes a learner knows (`useBeliefs` in `@gestalts/view`) to pick it. */
export { MODEL as FSRS_MODEL, Rating, fsrsDataValue, fsrsStates, getScheduler, isAhead, review, stateFromItem, withLocal, type Facet, type LocalReview, type FsrsStates, type Grade, type ReviewState, type Scheduler } from './learning';
export { IDLE_MS, SESSION_GAP_MS, PracticeSession, type SessionEvent } from './session';
export { usePracticeSession, useLocalReviews, saveReview, type PracticeLog } from './practice';
export { DUE_PREFERENCE, FLASHCARD_DUE_PREFERENCE, facetOf, isStruggling, nextItem, rate } from './drill';
export { logPractice, practiceEvent, ratingOf, type ConceptStrengths, type EventRating } from './evidence';
export { lessonPlan, mainConcept, rankNew, sideStrength, variantGroups, type NewItem, type Practising } from './variants';
