import { useEffect, useMemo, useState } from 'react';
import { Markdown } from '@gestalts/kit';
import { FLASHCARD_DUE_PREFERENCE, facetOf, fsrsStates, getScheduler, logConceptPractice, nextItem, Rating, review, saveReview, useLocalReviews, usePracticeSession, type ConceptStrengths, type FsrsStates, type Grade } from '@gestalts/learning';
import { useBlobUrl, useDoc, useQuery, useWrite, type Item, type QueryResult } from '@gestalts/view';

const GRADES: { grade: Grade; label: string; className: string }[] = [
  { grade: Rating.Again, label: 'Again', className: 'btn-error' },
  { grade: Rating.Hard, label: 'Hard', className: 'btn-warning' },
  { grade: Rating.Good, label: 'Good', className: 'btn-success' },
  { grade: Rating.Easy, label: 'Easy', className: 'btn-info' },
];

const blobNamed = (card: Item, label: string) => ((card.value.blobs ?? []) as { file: string; label: string }[]).find((b) => b.label === label)?.file;
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);

/** Every page of a query: a drill needs all its cards to pick from. */
function useAll(result: QueryResult): QueryResult {
  const { hasMore, more, items } = result;
  useEffect(() => { if (hasMore) more(); }, [hasMore, more, items.length]);
  return result;
}

/** See the front, recall, reveal the back, rate yourself. */
export default function Flashcards() {
  // only ids to pick from; the card on screen is loaded by itself
  const cards = useAll(useQuery({ gestalt: 'flashcard@1', tags: { none: ['no-generic-practice'] }, fields: [], limit: 200 }));
  const reviews = useAll(useQuery({ gestalt: 'fsrs-data@1', limit: 200 }));
  const write = useWrite();
  const stored = useMemo(() => fsrsStates(reviews.items), [reviews.items]);
  const { states, put } = useLocalReviews(stored);
  const log = usePracticeSession('flashcards');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [current, setCurrent] = useState<{ id: string | null; picked: boolean }>({ id: null, picked: false });

  const pick = (from: FsrsStates, lastId: string | null, now: Date) => setCurrent({ id: nextItem(cards.items, from, lastId, now, { duePreference: FLASHCARD_DUE_PREFERENCE })?.id ?? null, picked: true });

  const loaded = !cards.loading && !cards.hasMore && !reviews.loading && !reviews.hasMore && cards.items.length > 0;
  useEffect(() => {
    if (loaded && !current.picked) pick(states, null, new Date());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the first pick
  }, [loaded]);

  const onRate = async (card: Item, grade: Grade) => {
    const now = new Date();
    const f = facetOf(card.id);
    const prev = states.get(f);
    const next = { ...review(await getScheduler(), prev, grade, now), id: prev?.id };
    put(f, next);
    const fail = (e: unknown) => setSaveError(e instanceof Error ? e.message : String(e));
    saveReview(write, f, prev, next, log).catch(fail);
    logConceptPractice(write, card.id, card.value.concepts as ConceptStrengths | undefined, grade, now).catch(fail);
    pick(states.with(f, next), card.id, now);
  };

  const alert = saveError && (
    <div role="alert" className="alert alert-error m-4 text-sm">
      <span>Couldn't save your last answer: {saveError}</span>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSaveError(null)}>Dismiss</button>
    </div>
  );

  if (!cards.loading && !cards.items.length) return <p className="p-8 text-center text-base-content/60">No flashcards yet.</p>;
  if (!current.picked) return <div className="flex justify-center p-8"><span className="loading loading-spinner" /></div>;
  if (!current.id || !cards.items.some((c) => c.id === current.id)) {
    return (
      <div className="flex flex-col items-center gap-3 p-8 text-center">
        {alert}
        <p className="text-lg font-semibold">All caught up.</p>
        <p className="text-base-content/60">Nothing due right now.</p>
        <button type="button" className="btn btn-sm" onClick={() => pick(states, null, new Date())}>Check again</button>
      </div>
    );
  }
  return <div className="h-full overflow-y-auto p-4">{alert}<Card key={current.id} id={current.id} onShown={log.shown} onRate={onRate} /></div>;
}

function Card({ id, onShown, onRate }: { id: string; onShown: () => void; onRate: (card: Item, g: Grade) => Promise<void> }) {
  const card = useDoc('flashcard@1', id);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const ready = !!card;
  useEffect(() => { if (ready) onShown(); }, [ready, onShown]);
  const frontImage = useBlobUrl(card ? blobNamed(card, 'front') : undefined);
  const backImage = useBlobUrl(card && revealed ? blobNamed(card, 'back') : undefined);
  const audio = useBlobUrl(card && revealed ? blobNamed(card, 'audio') : undefined);
  if (!card) return <div className="flex justify-center p-8"><span className="loading loading-spinner" /></div>;
  const back = text(card.value.back);
  const extra = text(card.value.extra);
  return (
    <div className="card card-border mx-auto w-full max-w-xl bg-base-100">
      <div className="card-body gap-4">
        <Markdown text={String(card.value.front)} />
        {frontImage && <img src={frontImage} alt="" className="rounded-box max-h-72 self-center object-contain" />}
        {!revealed ? (
          <button type="button" className="btn btn-primary" onClick={() => setRevealed(true)}>Reveal</button>
        ) : (
          <>
            <div className="divider my-0" />
            {back && <Markdown text={back} />}
            {backImage && <img src={backImage} alt="" className="rounded-box max-h-72 self-center object-contain" />}
            {audio && <audio controls src={audio} className="w-full" />}
            {extra && <Markdown text={extra} className="text-sm text-base-content/70" />}
            <div className="grid w-full grid-cols-4 gap-2">
              {GRADES.map((g) => (
                <button key={g.grade} type="button" disabled={busy} className={`btn btn-sm btn-soft ${g.className}`}
                        onClick={() => { setBusy(true); void onRate(card, g.grade).finally(() => setBusy(false)); }}>{g.label}</button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
