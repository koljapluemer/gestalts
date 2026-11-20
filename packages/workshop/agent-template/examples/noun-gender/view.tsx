import { useState } from 'react';
import { useQuery, useWrite } from '@gestalts/view';
import { logPractice, ratingOf } from '@gestalts/learning';

type Noun = { word: string; gender: 'm' | 'f' | 'n'; plural?: string };
const ARTICLE = { m: 'der', f: 'die', n: 'das' } as const;

/** Pick the article; the draft's own gestalt `d-example/noun@1` holds the nouns it ships with. */
export default function View() {
  const { items, loading } = useQuery({ gestalt: 'd-example/noun@1', order: { seed: 7 }, limit: 50 });
  const write = useWrite();
  const [at, setAt] = useState(0);
  const [picked, setPicked] = useState<keyof typeof ARTICLE | null>(null);
  if (loading) return <div className="flex h-full items-center justify-center"><span className="loading loading-spinner" /></div>;
  if (!items.length) return <div className="flex h-full items-center justify-center text-base-content/60">No nouns yet.</div>;
  const item = items[at % items.length];
  const noun = item.value as unknown as Noun;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-4">
      <p className="text-4xl font-semibold">{picked ? `${ARTICLE[noun.gender]} ${noun.word}` : noun.word}</p>
      {picked && noun.plural && <p className="text-base-content/60">die {noun.plural}</p>}
      <div className="flex gap-2">
        {(Object.keys(ARTICLE) as (keyof typeof ARTICLE)[]).map((g) => (
          <button key={g} type="button" disabled={picked !== null}
                  className={`btn ${picked && g === noun.gender ? 'btn-success' : picked === g ? 'btn-error' : ''}`} onClick={() => {
                    setPicked(g);
                    void logPractice(write, item.id, 'der-die-das', ratingOf(g === noun.gender ? 3 : 1), new Date());
                  }}>{ARTICLE[g]}</button>
        ))}
      </div>
      {picked && <button type="button" className="btn btn-primary" onClick={() => { setPicked(null); setAt((n) => n + 1); }}>Next</button>}
    </div>
  );
}
