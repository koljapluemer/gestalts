import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Eye } from 'lucide-react';
import { Credits, Markdown } from '@gestalts/kit';
import { logPractice, usePracticeSession, type PracticeLog } from '@gestalts/learning';
import { useBeliefs, useDoc, useParams, useQuery, useWrite, type Belief, type QueryResult } from '@gestalts/view';

/**
 * Multiple-choice drills, one deck per topic. A topic is an `item-model@1`, its questions the `multiple-choice@1`s
 * made by it (`model`). Reveal the options, pick one: only the first pick counts, logged as a practice event (+1 right,
 * −1 wrong) on the question, which practises the topic's concepts. A wrong option is greyed out and you keep going;
 * the right one moves on. How well each topic is known comes from the app's beliefs about its main concept.
 *
 * Params: `model` (an item model's id; none lists the topics).
 */

const VIEW = 'math-drills';
const NEXT_MS = 500;

type Option = { text: string; correct: boolean };
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

// ---------- the look (phrasebook's) ----------

const OUTLINE = 'flex items-center justify-center gap-2 rounded-lg border border-white px-4 py-3 text-white transition-colors duration-150 hover:bg-white/10 disabled:opacity-50';
const PRIMARY = `${OUTLINE} bg-white/30`;
const RIGHT = 'flex items-center justify-center rounded-lg border border-white bg-white px-4 py-3 text-primary';
const WRONG = 'flex items-center justify-center rounded-lg border border-white/40 px-4 py-3 text-white/50 line-through';

function Shell({ mode, instruction, onBack, children }: { mode: string; instruction?: string; onBack?: () => void; children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto bg-linear-to-br from-primary via-secondary to-accent text-white">
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col gap-4 px-4 py-6">
        <div className="flex items-center justify-between gap-3">
          {onBack ? <button type="button" className="rounded-lg border border-white p-2 hover:bg-white/10" aria-label="Back" onClick={onBack}><ArrowLeft size={18} /></button> : <span />}
          <span className="text-sm font-medium">{mode}</span>
        </div>
        {instruction && <p className="font-mono text-sm">{instruction}</p>}
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
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/20" title={belief?.evidence ? `${Math.round(p * 100)}% · from ${belief.evidence} answers` : 'nothing yet'}>
      <div className="absolute inset-y-0 bg-white/30" style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }} />
      <div className="absolute inset-y-0 left-0 rounded-full bg-white" style={{ width: `${p * 100}%` }} />
    </div>
  );
}

// ---------- one question ----------

function Question({ id, onShown, onAnswered, onNext }: { id: string; onShown: () => void; onAnswered: (id: string, right: boolean) => void; onNext: () => void }) {
  const doc = useDoc('multiple-choice@1', id);
  const [revealed, setRevealed] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);
  const answered = useRef(false);
  const raw = doc?.value.options;
  // shuffled once per question, so picking doesn't reorder them
  const options = useMemo(() => shuffled((Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [])
    .map((o): Option => ({ text: str(o.text), correct: o.correct === true }))), [raw]);
  const done = picked.some((i) => options[i]?.correct);
  useEffect(() => { onShown(); }, [onShown]);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(onNext, NEXT_MS);
    return () => clearTimeout(t);
  }, [done, onNext]);

  if (!doc) return <div className="flex flex-1 items-center justify-center"><span className="loading loading-spinner" /></div>;
  const pick = (i: number) => {
    if (!answered.current) { answered.current = true; onAnswered(id, options[i].correct); }
    setPicked((p) => [...p, i]);
  };
  return (
    <>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        {str(doc.value.instruction) && <p className="text-sm text-white/80">{str(doc.value.instruction)}</p>}
        <Markdown text={str(doc.value.prompt)} className="text-3xl" />
      </div>
      {!revealed ? (
        <button type="button" className={PRIMARY} onClick={() => setRevealed(true)}><Eye size={16} /> Reveal answers</button>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {options.map((o, i) => {
            const chosen = picked.includes(i);
            const cls = chosen ? (o.correct ? RIGHT : WRONG) : OUTLINE;
            return (
              <button key={i} type="button" className={`${cls} text-xl`} disabled={chosen || done} onClick={() => pick(i)}>
                <Markdown text={o.text} inline />
              </button>
            );
          })}
        </div>
      )}
      <Credits sources={doc.value.sources} className="text-center text-white" />
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
          : <p className="text-center">No questions in this topic.</p>}
    </Shell>
  );
}

function Questions({ ids, log }: { ids: string[]; log: PracticeLog }) {
  const write = useWrite();
  const [current, setCurrent] = useState(() => draw(ids, null));
  const [error, setError] = useState<string | null>(null);
  const next = useCallback(() => setCurrent((last) => draw(ids, last)), [ids]);
  const answered = (id: string, right: boolean) => {
    const fail = (e: unknown) => setError(message(e));
    logPractice(write, id, VIEW, right ? 1 : -1, new Date()).catch(fail);
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
        <button key={m.id} type="button" className={`${OUTLINE} flex-col items-stretch`} onClick={() => setParams({ model: m.id })}>
          <span>{m.title}</span>
          <Bar belief={m.main ? beliefs.get(m.main) : undefined} />
        </button>
      ))}
    </Shell>
  );
}
