import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Credits } from '@gestalts/kit';
import { facetOf, fsrsStates, getScheduler, logPractice, nextItem, Rating, rate, saveReview, useLocalReviews, usePracticeSession, type FsrsStates, type PracticeLog } from '@gestalts/learning';
import { useBlobUrl, useQuery, useWrite, type QueryResult } from '@gestalts/view';

/**
 * Whose flag is this? A `flag@1`, and two names: its own and another flag's. The other is one it is confused with
 * (`lookalikes`) two times in three if it has any, else one of its region (`distractors`) two times in three, else any
 * flag. Only the first pick counts: Good or Again on the flag's spaced-repetition card (on the flag yml, never on a
 * concept, which world-map keeps a card on), and a practice event on the flag (+1, −1) with the wrong option shown.
 * A wrong pick is struck through and you pick again; the right one moves on. Next: due flags mostly, else unseen ones,
 * never the one before.
 */

const VIEW = 'flags-practice';
const TAG = 'flags-practice';
const NEXT_MS = 600;
const POOL_ODDS = 2 / 3;

type Flag = { id: string; country: string; name: string; image: string; lookalikes: string[]; distractors: string[]; sources: unknown };
type Question = { flag: Flag; other: Flag; options: [Flag, Flag] };

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pickRandom = <T,>(items: T[]): T => items[Math.floor(Math.random() * items.length)];

/** Every page of a query: what comes next is picked from all of them. */
function useAll(result: QueryResult): QueryResult {
  const { hasMore, more, items } = result;
  useEffect(() => { if (hasMore) more(); }, [hasMore, more, items.length]);
  return result;
}
const ready = (...rs: QueryResult[]) => rs.every((r) => !r.loading && !r.hasMore);

/** the wrong option: a look-alike, else one of its region, each pool taken two times in three; else any other flag */
function otherFlag(flag: Flag, byCountry: Map<string, Flag>, all: Flag[]): Flag {
  for (const codes of [flag.lookalikes, flag.distractors]) {
    const pool = codes.flatMap((c) => byCountry.get(c) ?? []);
    if (pool.length && Math.random() < POOL_ODDS) return pickRandom(pool);
  }
  return pickRandom(all.filter((f) => f.id !== flag.id));
}

function question(flag: Flag, byCountry: Map<string, Flag>, all: Flag[]): Question {
  const other = otherFlag(flag, byCountry, all);
  return { flag, other, options: Math.random() < 0.5 ? [flag, other] : [other, flag] };
}

// ---------- the look ----------

// picked options keep their colour: neither `disabled` nor `aria-disabled`, both of which daisy greys out; the click
// guard and `pointer-events-none` stop further picks
const OPTION = 'btn btn-lg h-auto min-h-12 py-2 text-xl font-normal';
const RIGHT = `${OPTION} btn-success pointer-events-none`;
const WRONG = `${OPTION} btn-soft btn-error pointer-events-none line-through`;

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-base-content/70">{children}</div>;
}

// ---------- one question ----------

function Exercise({ q, preload, onShown, onFirstPick, onNext }: {
  q: Question; preload: string | undefined; onShown: () => void; onFirstPick: (right: boolean, ms: number) => void; onNext: () => void;
}) {
  const url = useBlobUrl(q.flag.image);
  const preloadUrl = useBlobUrl(preload);
  const [picked, setPicked] = useState<string[]>([]);
  const shownAt = useRef(0);
  const done = picked.includes(q.flag.id);
  // on the clock event time stamps use, so the time to a pick is the click's own `timeStamp` less this
  useEffect(() => { shownAt.current = performance.now(); onShown(); }, [onShown]);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(onNext, NEXT_MS);
    return () => clearTimeout(t);
  }, [done, onNext]);

  const pick = (f: Flag, at: number) => {
    if (!picked.length) onFirstPick(f.id === q.flag.id, at - shownAt.current);
    setPicked((p) => [...p, f.id]);
  };
  return (
    <>
      <div className="flex flex-1 items-center justify-center">
        <div className="flex aspect-[4/3] w-full max-w-sm items-center justify-center overflow-hidden rounded-box border border-base-300">
          {url ? <img src={url} alt="the flag to name" className="max-h-full max-w-full object-contain" /> : <span className="loading loading-spinner" />}
        </div>
        {preloadUrl && <img src={preloadUrl} alt="" className="hidden" />}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {q.options.map((f) => {
          const chosen = picked.includes(f.id);
          const cls = chosen ? (f.id === q.flag.id ? RIGHT : WRONG) : done ? `${OPTION} pointer-events-none` : OPTION;
          return <button key={f.id} type="button" className={cls} onClick={(e) => { if (!chosen && !done) pick(f, e.timeStamp); }}>{f.name}</button>;
        })}
      </div>
    </>
  );
}

// ---------- the drill ----------

function Drill({ flags, stored, log }: { flags: Flag[]; stored: FsrsStates; log: PracticeLog }) {
  const write = useWrite();
  const { states, put } = useLocalReviews(stored);
  const statesRef = useRef(states);
  useEffect(() => { statesRef.current = states; }, [states]);
  const byCountry = useMemo(() => new Map(flags.map((f) => [f.country, f])), [flags]);
  const draw = useCallback((s: FsrsStates, last: string | null) => {
    const f = nextItem(flags, s, last, new Date());
    return f ? question(f, byCountry, flags) : null;
  }, [flags, byCountry]);

  const [current, setCurrent] = useState<{ q: Question | null; n: number }>(() => ({ q: draw(states, null), n: 0 }));
  // picked as soon as the first answer is in, so its image loads while this one shows it was right
  const [upcoming, setUpcoming] = useState<Question | null>(null);
  const [error, setError] = useState<string | null>(null);

  const firstPick = useCallback(async (right: boolean, ms: number) => {
    const q = current.q!;
    const now = new Date();
    const fail = (e: unknown) => setError(message(e));
    const f = facetOf(q.flag.id);
    const prev = statesRef.current.get(f);
    try {
      const next = { ...rate(await getScheduler(), prev, right ? Rating.Good : Rating.Again, now), id: prev?.id };
      put(f, next);
      const s = statesRef.current.with(f, next);
      statesRef.current = s;
      setUpcoming(draw(s, q.flag.id));
      saveReview(write, f, prev, next, log).catch(fail);
    } catch (e) { fail(e); }
    logPractice(write, q.flag.id, VIEW, right ? 1 : -1, now, { ms, instance: { labels: { distractor: q.other.country } } }).catch(fail);
  }, [current.q, put, draw, write, log]);
  const next = useCallback(() => {
    setCurrent((c) => ({ q: upcoming ?? draw(statesRef.current, c.q?.flag.id ?? null), n: c.n + 1 }));
    setUpcoming(null);
  }, [upcoming, draw]);
  const again = () => setCurrent((c) => ({ q: draw(statesRef.current, null), n: c.n + 1 }));

  return (
    <>
      {error && (
        <div role="alert" className="alert alert-error text-sm">
          <span>Couldn't save your last answer: {error}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
      {current.q
        ? <Exercise key={current.n} q={current.q} preload={upcoming?.flag.image} onShown={log.shown} onFirstPick={(r, ms) => { void firstPick(r, ms); }} onNext={next} />
        : <Centered><p>Nothing due right now.</p><button type="button" className="btn btn-sm" onClick={again}>Check again</button></Centered>}
      <Credits sources={current.q?.flag.sources ?? flags[0]?.sources} className="text-center" />
    </>
  );
}

// ---------- the view ----------

export default function FlagsPractice() {
  const log = usePracticeSession(VIEW);
  const flagItems = useAll(useQuery({ gestalt: 'flag@1', tags: { all: [TAG] }, fields: ['country', 'name', 'image', 'lookalikes', 'distractors', 'sources'], limit: 500 }));
  // the cards of this deck's flags: as many as the deck has, however much is practised
  const cards = useAll(useQuery({ gestalt: 'fsrs-data@1', links: { all: [{ field: 'target', to: { gestalt: 'flag@1', tags: { all: [TAG] } } }] }, limit: 500 }));
  const flags = useMemo(() => flagItems.items.map((i): Flag => ({
    id: i.id, country: str(i.value.country), name: str(i.value.name), image: str(i.value.image),
    lookalikes: strs(i.value.lookalikes), distractors: strs(i.value.distractors), sources: i.value.sources,
  })).filter((f) => f.country && f.name && f.image), [flagItems.items]);
  const stored = useMemo(() => fsrsStates(cards.items), [cards.items]);
  const loaded = ready(flagItems, cards);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col gap-4 p-4">
        <h1 className="text-lg font-semibold">Whose flag is this?</h1>
        {!loaded ? <Centered><span className="loading loading-spinner" /></Centered>
          : flags.length < 2 ? <Centered><p>No flags yet.</p></Centered>
            : <Drill flags={flags} stored={stored} log={log} />}
      </div>
    </div>
  );
}
