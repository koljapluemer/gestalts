import { useEffect } from 'react';
import { NoteCard } from '@gestalts/kit';
import { useQuery, useViewState } from '@gestalts/view';

const QUEUE_SIZE = 3;
const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];

/** The app draws the notes, so this never holds more of them than it shows. */
export default function NoteQueue() {
  const [seed, setSeed] = useViewState<number>('seed', newSeed());
  const { items, loading, error } = useQuery({ gestalt: 'note@1', tags: { none: ['no-queue'] }, order: { seed }, limit: QUEUE_SIZE });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'n' && !e.metaKey && !e.ctrlKey) setSeed(newSeed()); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [setSeed]);
  if (error) return <div role="alert" className="alert alert-error m-4">{error}</div>;
  if (loading) return null;
  if (!items.length) return <p className="p-8 text-center text-base-content/60">No notes for the queue yet.</p>;
  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col gap-4 overflow-y-auto p-4">
      {items.map((n) => <div key={n.id} className="card card-border bg-base-100"><div className="card-body"><NoteCard value={n.value} /></div></div>)}
      <button type="button" className="btn self-center" onClick={() => setSeed(newSeed())}>Next</button>
    </div>
  );
}
