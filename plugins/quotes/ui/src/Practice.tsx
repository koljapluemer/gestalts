import { useEffect, useMemo, useRef, useState } from 'react';
import { definePerspective, logger, stateKey, type Query } from '@gestalts/sdk';
import { fsrsStates, getScheduler, Rating, review, saveReview, useLocalReviews, usePracticeSession, type Grade } from '@gestalts/learning';
import { clozeFront, clozeParts } from './cloze';
import { pickNext, type Candidate } from './queue';
import { quoteOf } from './quote';

const log = logger('quotes');

const GRADES: { grade: Grade; label: string }[] = [
  { grade: Rating.Again, label: 'Again' },
  { grade: Rating.Hard, label: 'Hard' },
  { grade: Rating.Good, label: 'Good' },
  { grade: Rating.Easy, label: 'Easy' },
];

/**
 * One cloze at a time: a quote with its last words hidden, more of them as it's learned. Each level is a facet of
 * the quote's `fsrs-state`; the reviews go into the `quotes` practice session.
 */
export const Practice = definePerspective<{ quotes: Query; reviews: Query }, { onManage?: () => void }>({
  id: 'quotes-practice',
  title: 'Practice',
  data: { quotes: { gestalt: 'quote@1', tagsNone: ['retired'] }, reviews: { gestalt: 'fsrs-state@1' } },
  Component: ({ data, repo, onManage }) => {
    const quotes = useMemo(() => data.quotes.flatMap((n) => quoteOf(n) ?? []), [data.quotes]);
    const { states, put } = useLocalReviews(useMemo(() => fsrsStates(data.reviews), [data.reviews]));
    const session = usePracticeSession('quotes');
    // practised this session: spread practice across quotes (not kept)
    const touched = useRef(new Set<string>());
    const [turn, setTurn] = useState<{ last: string | null; at: number; shown: Candidate | null }>({ last: null, at: Date.now(), shown: null });
    const [error, setError] = useState<string | null>(null);
    const picked = useMemo(() => pickNext(quotes, states, new Date(turn.at), turn.last, touched.current), [quotes, states, turn.at, turn.last]);
    // the cloze shown stays until it's rated, even if a sync changes the picks
    const current = turn.shown && quotes.some((q) => q.id === turn.shown?.quote.id) ? turn.shown : picked;
    useEffect(() => {
      if (current && current !== turn.shown) setTurn((t) => ({ ...t, shown: current }));
    }, [current, turn.shown]);

    const rate = async (c: Candidate, grade: Grade) => {
      const prev = states.get(c.facet);
      const next = { ...review(await getScheduler(), prev, grade, new Date()), key: prev?.key ?? stateKey('fsrs-state', c.facet.target, c.facet.facet) };
      put(c.facet, next);
      touched.current.add(c.quote.id);
      const saving = saveReview(repo, c.facet, prev, next, session);
      setTurn({ last: c.quote.id, at: Date.now(), shown: null });
      saving.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
      log.info('rated', { quote: c.quote.id, level: c.level, grade });
    };

    if (!quotes.length) {
      return (
        <div className="flex flex-col items-center gap-4 p-8 text-center text-base-content/70">
          <p>No quotes yet. Add one to get started.</p>
          {onManage && <button type="button" className="btn btn-primary" onClick={onManage}>Add a quote</button>}
        </div>
      );
    }
    return (
      <div className="mx-auto flex w-full max-w-md flex-col gap-4">
        {error && (
          <div role="alert" className="alert alert-error text-sm">
            <span>Couldn't save the review: {error}</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setError(null)}>Dismiss</button>
          </div>
        )}
        {current
          ? <Cloze key={`${current.quote.id}:${current.level}@${turn.at}`} c={current} onShown={session.shown} onRate={(g) => rate(current, g)} />
          : (
            <div className="flex flex-col items-center gap-3 p-8 text-center text-base-content/60">
              <p>All caught up. Nothing due right now.</p>
              <button type="button" className="btn btn-sm" onClick={() => setTurn((t) => ({ ...t, at: Date.now() }))}>Check again</button>
            </div>
          )}
      </div>
    );
  },
});

function Cloze({ c, onShown, onRate }: { c: Candidate; onShown: () => void; onRate: (g: Grade) => Promise<void> }) {
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(onShown, [onShown]);
  const parts = clozeParts(c.quote.text, c.level);
  const rate = (g: Grade) => {
    if (busy) return;
    setBusy(true);
    onRate(g).catch(() => setBusy(false));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(t.tagName)) return;
      if (!revealed && e.key === ' ') { e.preventDefault(); setRevealed(true); }
      const g = GRADES[Number(e.key) - 1];
      if (revealed && g) { e.preventDefault(); rate(g.grade); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div className="card w-full bg-base-100 shadow-xl">
      <div className="card-body items-center gap-4 text-center">
        {c.quote.attribution && <p className="text-sm italic opacity-60">{c.quote.attribution}</p>}
        {!revealed ? (
          <>
            <p className="text-2xl font-medium">{clozeFront(c.quote.text, c.level)}</p>
            <button type="button" className="btn" onClick={() => setRevealed(true)}>Show answer <kbd className="kbd kbd-sm">Space</kbd></button>
          </>
        ) : (
          <>
            <p className="text-2xl font-medium">{parts.visible && <span>{parts.visible} </span>}<mark className="rounded bg-warning/60">{parts.hidden}</mark></p>
            <div className="divider my-0" />
            <div className="grid w-full grid-cols-4 gap-2">
              {GRADES.map(({ grade, label }, i) => (
                <button key={grade} type="button" className="btn btn-sm sm:btn-md" disabled={busy} onClick={() => rate(grade)}>
                  {label} <kbd className="kbd kbd-xs max-sm:hidden">{i + 1}</kbd>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
