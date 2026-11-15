import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Eye } from 'lucide-react';
import { Credits, Markdown } from '@gestalts/kit';
import { logPractice, usePracticeSession, type EventDetails, type PracticeLog } from '@gestalts/learning';
import { useBeliefs, useDoc, useParams, useQuery, useWrite, type Belief, type JsonMap, type QueryResult } from '@gestalts/view';

/**
 * Multiple-choice drills, one deck per topic. A topic is an `item-model@1`, its questions the `multiple-choice@1`s
 * made by it (`model`). Reveal the options, pick one: only the first pick counts, logged as a practice event (+1 right,
 * −1 wrong) on the question, with the picked option's `response` (the mistake it stands for), the question's
 * `instance` and the time from showing the question to the pick. The app reads the response as evidence about the
 * mistake's concepts, and the question's `chance` as how likely a guess was. A wrong option is greyed out and you keep
 * going; the right one moves on. How well each topic is known comes from the app's beliefs about its main concept.
 *
 * Params: `model` (an item model's id; none lists the topics).
 */

const VIEW = 'math-drills';
const NEXT_MS = 500;

type Option = { text: string; correct: boolean; response?: string };
type Model = { id: string; title: string; main: string | null; sources: unknown };

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Every page of a query. */
function useAll(result: QueryResult): QueryResult {
  const { hasMore, more, items } = result;
  useEffect(() => { if (hasMore) more(); }, [hasMore, more, items.length]);
  return result;
}

function shuffled<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The concept a model practises most: what its bar shows. */
function mainConcept(concepts: unknown): string | null {
  if (!concepts || typeof concepts !== 'object' || Array.isArray(concepts)) return null;
  const best = Object.entries(concepts as Record<string, number>).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

// ---------- the look ----------

// picked options keep their colour: no `disabled`, which daisy greys out, but no clicks either
const OPTION = 'btn btn-lg h-auto min-h-12 py-2 text-xl font-normal';
const RIGHT = `${OPTION} btn-success pointer-events-none`;
const WRONG = `${OPTION} btn-soft btn-error pointer-events-none line-through`;

function Shell({ mode, instruction, onBack, children }: { mode: string; instruction?: string; onBack?: () => void; children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col gap-4 p-4">
        <div className="flex items-center gap-2">
          {onBack && <button type="button" className="btn btn-ghost btn-sm btn-square" title="Back" aria-label="Back" onClick={onBack}><ArrowLeft className="size-4" /></button>}
          <h1 className="text-lg font-semibold">{mode}</h1>
        </div>
        {instruction && <p className="text-sm text-base-content/70">{instruction}</p>}
        <div className="flex flex-1 flex-col gap-4">{children}</div>
      </div>
    </div>
  );
}

function Bar({ belief }: { belief?: Belief }) {
  const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
  const p = belief?.p ?? 0.5;
  const lo = belief ? sigmoid(belief.mean - belief.sd) : 0;
  const hi = belief ? sigmoid(belief.mean + belief.sd) : 1;
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-base-300" title={belief?.evidence ? `${Math.round(p * 100)}% · from ${belief.evidence} answers` : 'nothing yet'}>
      <div className="absolute inset-y-0 bg-primary/30" style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }} />
      <div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${p * 100}%` }} />
    </div>
  );
}

// ---------- one question ----------

function Question({ id, onShown, onAnswered, onNext }: { id: string; onShown: () => void; onAnswered: (id: string, right: boolean, details: EventDetails) => void; onNext: () => void }) {
  const doc = useDoc('multiple-choice@1', id);
  const [revealed, setRevealed] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);
  const answered = useRef(false);
  const shownAt = useRef(0);
  const raw = doc?.value.options;
  // shuffled once per question, so picking doesn't reorder them
  const options = useMemo(() => shuffled((Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [])
    .map((o): Option => ({ text: str(o.text), correct: o.correct === true, ...(str(o.response) ? { response: str(o.response) } : {}) }))), [raw]);
  const done = picked.some((i) => options[i]?.correct);
  // on the clock event time stamps use, so the time to a pick is the click's own `timeStamp` less this
  useEffect(() => { shownAt.current = performance.now(); onShown(); }, [onShown]);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(onNext, NEXT_MS);
    return () => clearTimeout(t);
  }, [done, onNext]);

  if (!doc) return <div className="flex flex-1 items-center justify-center"><span className="loading loading-spinner" /></div>;
  const pick = (i: number, at: number) => {
    if (!answered.current) {
      answered.current = true;
      const instance = doc.value.instance;
      onAnswered(id, options[i].correct, {
        ...(options[i].response ? { response: options[i].response } : {}),
        ...(instance && typeof instance === 'object' && !Array.isArray(instance) ? { instance: instance as JsonMap } : {}),
        ms: at - shownAt.current,
      });
    }
    setPicked((p) => [...p, i]);
  };
  return (
    <>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        {str(doc.value.instruction) && <p className="text-sm text-base-content/70">{str(doc.value.instruction)}</p>}
        <Markdown text={str(doc.value.prompt)} className="text-3xl" />
      </div>
      {!revealed ? (
        <button type="button" className="btn btn-primary" onClick={() => setRevealed(true)}><Eye className="size-4" /> Reveal answers</button>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {options.map((o, i) => {
            const chosen = picked.includes(i);
            const cls = chosen ? (o.correct ? RIGHT : WRONG) : done ? `${OPTION} pointer-events-none` : OPTION;
            return (
              <button key={i} type="button" className={cls} aria-disabled={chosen || done} onClick={(e) => { if (!chosen && !done) pick(i, e.timeStamp); }}>
                <Markdown text={o.text} inline />
              </button>
            );
          })}
        </div>
      )}
      <Credits sources={doc.value.sources} className="text-center" />
    </>
  );
}

// ---------- one topic ----------

/** A random question, never the one just asked when there's another. */
const draw = (ids: string[], last: string | null) => {
  const others = ids.length > 1 ? ids.filter((i) => i !== last) : ids;
  return others[Math.floor(Math.random() * others.length)];
};

function Drill({ model, log, onBack }: { model: Model; log: PracticeLog; onBack: () => void }) {
  const items = useAll(useQuery({ gestalt: 'multiple-choice@1', where: { model: model.id }, fields: ['model'], limit: 500 }));
  const ids = useMemo(() => items.items.map((i) => i.id), [items.items]);
  return (
    <Shell mode={model.title} onBack={onBack}>
      {items.loading || items.hasMore ? <div className="flex flex-1 items-center justify-center"><span className="loading loading-spinner" /></div>
        : ids.length ? <Questions ids={ids} log={log} />
          : <p className="text-center text-base-content/60">No questions in this topic.</p>}
    </Shell>
  );
}

function Questions({ ids, log }: { ids: string[]; log: PracticeLog }) {
  const write = useWrite();
  const [current, setCurrent] = useState(() => draw(ids, null));
  const [error, setError] = useState<string | null>(null);
  const next = useCallback(() => setCurrent((last) => draw(ids, last)), [ids]);
  const answered = (id: string, right: boolean, details: EventDetails) => {
    const fail = (e: unknown) => setError(message(e));
    logPractice(write, id, VIEW, right ? 1 : -1, new Date(), details).catch(fail);
    log.trial().catch(fail);
  };
  return (
    <>
      {error && (
        <div role="alert" className="alert alert-error text-sm">
          <span>Couldn't save your last answer: {error}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
      <Question key={current} id={current} onShown={log.shown} onAnswered={answered} onNext={next} />
    </>
  );
}

// ---------- the view ----------

export default function MathDrills() {
  const [params, setParams] = useParams();
  const log = usePracticeSession(VIEW);
  const result = useAll(useQuery({ gestalt: 'item-model@1', tags: { all: ['math-drills'] }, fields: ['title', 'name', 'concepts', 'sources'], limit: 500 }));
  const models = useMemo(() => result.items
    .map((i): Model => ({ id: i.id, title: str(i.value.title) || str(i.value.name), main: mainConcept(i.value.concepts), sources: i.value.sources }))
    .sort((a, b) => a.title.localeCompare(b.title)), [result.items]);
  const mains = useMemo(() => (models.length ? models.flatMap((m) => (m.main ? [m.main] : [])) : null), [models]);
  const { beliefs } = useBeliefs(mains);

  if (result.loading || result.hasMore) return <div className="flex h-full items-center justify-center"><span className="loading loading-spinner" /></div>;

  const model = models.find((m) => m.id === params.model);
  if (model) return <Drill key={model.id} model={model} log={log} onBack={() => setParams({})} />;

  return (
    <Shell mode="Math Drills" instruction={models.length ? 'Which topic?' : 'No math decks here yet.'}>
      {models.map((m) => (
        <button key={m.id} type="button" className="btn h-auto flex-col items-stretch gap-2 py-3 font-normal" onClick={() => setParams({ model: m.id })}>
          <span>{m.title}</span>
          <Bar belief={m.main ? beliefs.get(m.main) : undefined} />
        </button>
      ))}
    </Shell>
  );
}
