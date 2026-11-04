import { useEffect, useMemo, useState } from 'react';
import { FileText } from 'lucide-react';
import { hashing, logger, stateKey, type Query, definePerspective } from '@gestalts/sdk';
import { fsrsStates, getScheduler, learnableCards, pickNext, Rating, review, saveReview, slotOf, until, useLocalReviews, usePracticeSession, type Grade, type LearnCard } from '@gestalts/learning';
import { Markdown } from '@gestalts/kit';

const log = logger('learn');

type Props = {
  /** open a card's note (its host, or the card note); without it there's no button for it */
  onOpen?: (key: string) => void;
};

const GRADES: { grade: Grade; label: string }[] = [
  { grade: Rating.Again, label: 'Again' },
  { grade: Rating.Hard, label: 'Hard' },
  { grade: Rating.Good, label: 'Good' },
  { grade: Rating.Easy, label: 'Easy' },
];

/** Keys typed into a field or over a dialog (the note editor) aren't for the card. */
function forCard(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  const typing = t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(t.tagName));
  return !typing && !e.metaKey && !e.ctrlKey && !e.altKey && !document.querySelector('dialog[open]');
}

/**
 * Spaced repetition of every flashcard (as dsl's Learn tab): a random due card, else a random new one. Its front,
 * then front and back with the four ratings.
 */
export const Learn = definePerspective<{ hosts: Query; flashcards: Query; reviews: Query }, Props>({
  id: 'learn',
  title: 'Learn',
  data: {
    hosts: { gestalt: 'cards@1', tagsNone: ['retired'] },
    flashcards: { gestalt: 'flashcard@1', tagsNone: ['retired'] },
    reviews: { gestalt: 'fsrs-state@1' },
  },
  Component: ({ data, repo, onOpen }) => {
    const cards = useMemo(() => learnableCards(data.hosts, data.flashcards, hashing), [data.hosts, data.flashcards]);
    const stored = useMemo(() => fsrsStates(data.reviews), [data.reviews]);
    // reviews made here count at once; their saves run in the background (and may wait behind a sync)
    const { states, put } = useLocalReviews(stored);
    const [saveError, setSaveError] = useState<string | null>(null);
    const session = usePracticeSession('learn');
    const [current, setCurrent] = useState<{ slot: string | null; last: string | null; at: number }>({ slot: null, last: null, at: Date.now() });

    const pick = useMemo(() => pickNext(cards, states, current.last, new Date(current.at)), [cards, states, current.last, current.at]);
    // the card shown stays until it's rated, even if the picks around it change (a sync, an edit)
    const shown = cards.find((c) => slotOf(c.facet) === current.slot) ?? null;
    const card = shown ?? pick.card;
    const slot = card ? slotOf(card.facet) : null;
    useEffect(() => {
      if (slot && slot !== current.slot) setCurrent((c) => ({ ...c, slot }));
    }, [slot, current.slot]);
    useEffect(() => {
      if (current.slot !== null) return;
      // a fresh pick (after a rating, or on opening): what came up and why
      const data = { slot, last: current.last, counts: pick.counts, nextDue: pick.nextDue };
      if (slot && slot === current.last) log.warn('picked the card just rated again', data);
      else log.info(slot ? 'pick' : 'nothing to pick', data);
    }, [slot, current.slot, current.last, pick]);

    const onRate = async (c: LearnCard, grade: Grade) => {
      const at = new Date();
      const prev = states.get(c.facet);
      const slot = slotOf(c.facet);
      log.info('rate', { slot, grade, prevDue: prev?.card.dueAt ?? null });
      const next = { ...review(await getScheduler(), prev, grade, at), key: prev?.key ?? stateKey('fsrs-state', c.facet.target, c.facet.facet) };
      put(c.facet, next);
      // records the trial before the next card is shown
      const saving = saveReview(repo, c.facet, prev, next, session);
      setCurrent({ slot: null, last: slot, at: Date.now() });
      saving.then(
        () => log.info('rated', { slot, nextDue: next.card.dueAt }),
        (e: unknown) => setSaveError(`${c.front.split('\n')[0].slice(0, 60)}: ${e instanceof Error ? e.message : String(e)}`),
      );
    };

    const counts = (
      <span className="ml-auto font-mono text-xs text-base-content/50" title="due · new · all cards">
        {pick.counts.due} · {pick.counts.new} · {pick.counts.total}
      </span>
    );
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <div className="flex min-h-8 items-center gap-1">
          {card && onOpen && (
            <button type="button" className="btn btn-ghost btn-sm btn-square" title="Open its note" onClick={() => onOpen(card.noteKey)}>
              <FileText className="size-4" />
            </button>
          )}
          {counts}
        </div>
        {saveError && (
          <div role="alert" className="alert alert-error text-sm">
            <span>Couldn't save the review of {saveError}</span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSaveError(null)}>Dismiss</button>
          </div>
        )}
        {card ? (
          <Review key={`${slot}@${current.at}`} card={card} onShown={session.shown} onOpen={onOpen} onRate={(g) => onRate(card, g)} />
        ) : (
          <div className="flex flex-col items-center gap-3 p-8 text-center text-base-content/60">
            <p>{!cards.length ? 'No flashcards.' : pick.nextDue ? `Nothing due. Next in ${until(pick.nextDue)}.` : 'Nothing due.'}</p>
            {cards.length > 0 && (
              <button type="button" className="btn btn-sm" onClick={() => setCurrent({ slot: null, last: null, at: Date.now() })}>Check again</button>
            )}
          </div>
        )}
      </div>
    );
  },
});

function Review({ card, onShown, onOpen, onRate }: { card: LearnCard; onShown: () => void; onOpen?: (key: string) => void; onRate: (g: Grade) => Promise<void> }) {
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(onShown, [onShown]);

  const rate = (g: Grade) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    // stays busy on success: the next card replaces this one
    onRate(g).catch((e: unknown) => { setBusy(false); setError(e instanceof Error ? e.message : String(e)); });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!forCard(e)) return;
      if (!revealed && e.key === ' ') { e.preventDefault(); setRevealed(true); }
      const g = GRADES[Number(e.key) - 1];
      if (revealed && g) { e.preventDefault(); rate(g.grade); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <>
      <div className="md-card rounded-box border border-base-300 bg-base-100 p-4">
        <Markdown text={card.front} onOpen={onOpen} />
        {revealed && <><hr className="my-3 border-base-300" /><Markdown text={card.back} onOpen={onOpen} /></>}
      </div>
      {revealed ? (
        <div className="grid grid-cols-4 gap-2">
          {GRADES.map((g, i) => (
            <button key={g.grade} type="button" className="btn" title={String(i + 1)} disabled={busy} onClick={() => rate(g.grade)}>{g.label}</button>
          ))}
        </div>
      ) : (
        <button type="button" className="btn btn-primary btn-block" title="Space" onClick={() => setRevealed(true)}>Reveal</button>
      )}
      {error && <div role="alert" className="alert alert-error text-sm">Couldn't save the review: {error}</div>}
    </>
  );
}
