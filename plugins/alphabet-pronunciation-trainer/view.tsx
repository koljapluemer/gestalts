import { useEffect, useMemo, useState } from 'react';
import { facetOf, fsrsStates, getScheduler, isStruggling, logPractice, nextItem, Rating, rate, ratingOf, saveReview, useLocalReviews, usePracticeSession, type Grade } from '@gestalts/learning';
import { useBlobUrl, useQuery, useWrite, type Item, type QueryResult } from '@gestalts/view';

const GRADES: { grade: Grade; label: string; className: string }[] = [
  { grade: Rating.Again, label: 'Again', className: 'btn-error' },
  { grade: Rating.Hard, label: 'Hard', className: 'btn-warning' },
  { grade: Rating.Good, label: 'Good', className: 'btn-success' },
  { grade: Rating.Easy, label: 'Easy', className: 'btn-info' },
];

const blobNamed = (e: Item, label: string) => ((e.value.blobs ?? []) as { file: string; label: string }[]).find((b) => b.label === label)?.file;
/** Not every card with the tag is usable: this drill needs a picture and a recording. */
const isExercise = (e: Item) => !!blobNamed(e, 'back') && !!blobNamed(e, 'audio');
const langOf = (e: Item) => ((e.value.tags ?? []) as string[]).find((t) => t.startsWith('lang:'))?.slice('lang:'.length);

/** Every page of a query: a drill needs all its exercises to pick from. */
function useAll(result: QueryResult): QueryResult {
  const { hasMore, more, items } = result;
  useEffect(() => { if (hasMore) more(); }, [hasMore, more, items.length]);
  return result;
}

/** Read a word aloud in a script you're learning, then check against the recording and rate yourself. */
export default function AlphabetTrainer() {
  const cards = useAll(useQuery({ gestalt: 'flashcard@1', tags: { all: ['alphabet-pronunciation'] }, limit: 200 }));
  const exercises = useMemo(() => cards.items.filter(isExercise), [cards.items]);
  const reviews = useAll(useQuery({ gestalt: 'fsrs-data@1', limit: 200 }));
  const write = useWrite();
  const stored = useMemo(() => fsrsStates(reviews.items), [reviews.items]);
  const { states, put } = useLocalReviews(stored);
  const log = usePracticeSession('alphabet-pronunciation-trainer');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [current, setCurrent] = useState<{ id: string | null; picked: boolean }>({ id: null, picked: false });

  const loaded = !cards.loading && !cards.hasMore && !reviews.loading && !reviews.hasMore && exercises.length > 0;
  useEffect(() => {
    if (!loaded || current.picked) return;
    setCurrent({ id: nextItem(exercises, states, null, new Date())?.id ?? null, picked: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the first pick
  }, [loaded]);

  const exercise = exercises.find((e) => e.id === current.id);

  const onRate = async (grade: Grade) => {
    if (!exercise) return;
    const now = new Date();
    const f = facetOf(exercise.id);
    const prev = states.get(f);
    const next = { ...rate(await getScheduler(), prev, grade, now), id: prev?.id };
    put(f, next);
    const saving = saveReview(write, f, prev, next, log);
    setCurrent({ id: nextItem(exercises, states.with(f, next), exercise.id, now)?.id ?? null, picked: true });
    const fail = (e: unknown) => setSaveError(e instanceof Error ? e.message : String(e));
    saving.catch(fail);
    logPractice(write, exercise.id, 'alphabet-pronunciation-trainer', ratingOf(grade), now).catch(fail);
  };

  const alert = saveError && (
    <div role="alert" className="alert alert-error m-4 text-sm">
      <span>Couldn't save your last answer: {saveError}</span>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSaveError(null)}>Dismiss</button>
    </div>
  );

  if (!cards.loading && !cards.hasMore && !exercises.length) return <p className="p-8 text-center text-base-content/60">No exercises here yet.</p>;
  if (!current.picked) return <div className="flex justify-center p-8"><span className="loading loading-spinner" /></div>;
  if (!exercise) {
    return (
      <div className="flex flex-col items-center gap-3 p-8 text-center">
        {alert}
        <p className="text-lg font-semibold">All caught up.</p>
        <p className="text-base-content/60">Nothing due right now.</p>
        <button type="button" className="btn btn-sm" onClick={() => setCurrent({ id: nextItem(exercises, states, null, new Date())?.id ?? null, picked: true })}>Check again</button>
      </div>
    );
  }
  return <div className="h-full overflow-y-auto p-4">{alert}<Exercise key={exercise.id} exercise={exercise} struggling={isStruggling(states.get(facetOf(exercise.id)))} onShown={log.shown} onRate={onRate} /></div>;
}

function Exercise({ exercise, struggling, onShown, onRate }: { exercise: Item; struggling: boolean; onShown: () => void; onRate: (g: Grade) => Promise<void> }) {
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(onShown, [onShown]);
  const image = useBlobUrl(blobNamed(exercise, 'back'));
  const audio = useBlobUrl(revealed ? blobNamed(exercise, 'audio') : undefined);
  return (
    <div className="card card-border mx-auto w-full max-w-md bg-base-100">
      <div className="card-body items-center gap-4 text-center">
        <p className="text-sm text-base-content/60">Try to pronounce this</p>
        <p lang={langOf(exercise)} className="text-5xl leading-tight break-words">{String(exercise.value.front)}</p>
        {(struggling || revealed) && image && <img src={image} alt="" className="rounded-box max-h-56 object-contain" />}
        {!revealed ? (
          <button type="button" className="btn btn-primary" onClick={() => setRevealed(true)}>Show Pronunciation</button>
        ) : (
          <>
            {audio && <audio controls autoPlay src={audio} className="w-full" />}
            <div className="grid w-full grid-cols-4 gap-2">
              {GRADES.map((g) => (
                <button key={g.grade} type="button" disabled={busy} className={`btn btn-sm btn-soft ${g.className}`}
                        onClick={() => { setBusy(true); void onRate(g.grade).finally(() => setBusy(false)); }}>{g.label}</button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
