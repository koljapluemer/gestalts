import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, Mic, Play, RotateCcw, Square, ThumbsDown, ThumbsUp } from 'lucide-react';
import { Credits, Markdown } from '@gestalts/kit';
import { facetOf, fsrsStates, getScheduler, lessonPlan, logPractice, mainConcept, rankNew, Rating, ratingOf, review, saveReview, useLocalReviews, usePracticeSession, type FsrsStates, type Grade, type PracticeLog } from '@gestalts/learning';
import { useBeliefs, useCapabilities, useDoc, useParams, useQuery, useWrite, type Belief, type Item, type QueryResult } from '@gestalts/view';

/**
 * Learn to say everyday things in another language (after laminla): see what you want to say, say it aloud, check,
 * rate yourself. Cards are `flashcard@1`s tagged `phrasebook` and `lang:<iso3>`, from decks that link their concepts
 * into one graph: every way of saying a phrase (to whom, how politely) shares the phrase's concept and adds its own.
 * What the learner can do comes from the app's beliefs about those concepts, never from loading practice.
 *
 * Params: `lang` (an iso3 code; none lists the languages), `screen` (`learn`, `lesson` or `progress`; none is the
 * language's home).
 */

const VIEW = 'phrasebook';
const LESSON_SIZE = 10;
const TAKES = 3;
const WAIT_MS = 3000;

type Card = { id: string; lang: string; concepts: Record<string, number>; sources: unknown };
type Deck = { id: string; name: string; title: string; members: string[] };
type Concept = { id: string; name: string; aliases: string[] };
type Link = { from: string; to: string; weight: number };

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function cardOf(i: Item): Card | null {
  const lang = strings(i.value.tags).find((t) => t.startsWith('lang:'))?.slice('lang:'.length);
  if (!lang) return null;
  const concepts = (i.value.concepts && typeof i.value.concepts === 'object' && !Array.isArray(i.value.concepts) ? i.value.concepts : {}) as Record<string, number>;
  return { id: i.id, lang, concepts, sources: i.value.sources };
}

/** Every page of a query: the deck's graph and cards are needed whole. */
function useAll(result: QueryResult): QueryResult {
  const { hasMore, more, items } = result;
  useEffect(() => { if (hasMore) more(); }, [hasMore, more, items.length]);
  return result;
}

/** The time, a minute at a time: what's due changes with it. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const isDue = (states: FsrsStates, id: string, now: Date) => { const s = states.get(facetOf(id)); return !!s && new Date(s.card.dueAt) <= now; };

/** `vie: address as anh` is "address as anh" here; the prefix says whose it is. */
const shortName = (name: string) => name.replace(/^[^:]+:\s*/, '');

// ---------- the graph of the installed phrase decks ----------

type Graph = {
  cards: Card[];
  decks: Deck[];
  concepts: Map<string, Concept>;
  links: Link[];
  /** the language's name, from its `lang: <iso3>` concept */
  languageName: (lang: string) => string;
};

function useGraph(): { graph: Graph; loading: boolean; error?: string } {
  const cardQuery = useAll(useQuery({ gestalt: 'flashcard@1', tags: { all: ['phrasebook'] }, fields: ['tags', 'concepts', 'sources'], limit: 500 }));
  const deckQuery = useAll(useQuery({ gestalt: 'deck@1', fields: ['name', 'title', 'members'], limit: 100 }));
  const cards = useMemo(() => cardQuery.items.flatMap((i) => cardOf(i) ?? []), [cardQuery.items]);
  const decks = useMemo(() => {
    const ids = new Set(cards.map((c) => c.id));
    return deckQuery.items
      .map((d) => ({ id: d.id, name: str(d.value.name), title: str(d.value.title) || str(d.value.name), members: strings(d.value.members) }))
      .filter((d) => d.members.some((m) => ids.has(m)));
  }, [deckQuery.items, cards]);
  // only what the phrase decks hold, by id
  const members = useMemo(() => (decks.length ? [...new Set(decks.flatMap((d) => d.members))].sort() : null), [decks]);
  const conceptQuery = useAll(useQuery(members && { gestalt: 'concept@2', ids: members, fields: ['name', 'aliases'], limit: 500 }));
  const linkQuery = useAll(useQuery(members && { gestalt: 'concept-link@1', ids: members, fields: ['from', 'to', 'weight'], limit: 500 }));
  const graph = useMemo<Graph>(() => {
    const concepts = new Map(conceptQuery.items.map((c) => [c.id, { id: c.id, name: str(c.value.name), aliases: strings(c.value.aliases) }]));
    const byName = new Map([...concepts.values()].map((c) => [c.name, c]));
    const links = linkQuery.items.map((l) => ({ from: str(l.value.from), to: str(l.value.to), weight: Number(l.value.weight) }));
    return { cards, decks, concepts, links, languageName: (lang) => byName.get(`lang: ${lang}`)?.aliases[0] ?? lang };
  }, [cards, decks, conceptQuery.items, linkQuery.items]);
  const queries = [cardQuery, deckQuery, conceptQuery, linkQuery];
  return { graph, loading: queries.some((q) => q.loading || q.hasMore), error: queries.find((q) => q.error)?.error };
}

// ---------- recording ----------

const BARS = 32;

/** The microphone: a take at a time, its live levels while recording, a playable URL after. Kept in memory only. */
function useRecorder() {
  const [recording, setRecording] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>(() => Array.from({ length: BARS }, () => 0));
  const [error, setError] = useState<string | null>(null);
  const parts = useRef<{ recorder: MediaRecorder; stream: MediaStream; ctx?: AudioContext; frame: number } | null>(null);
  const urlRef = useRef<string | null>(null);

  const release = useCallback(() => {
    const p = parts.current;
    if (!p) return;
    cancelAnimationFrame(p.frame);
    p.stream.getTracks().forEach((t) => t.stop());
    void p.ctx?.close();
    parts.current = null;
    setLevels(Array.from({ length: BARS }, () => 0));
  }, []);

  /** Records until `stop`; the take goes to `onTake` (which then owns its URL) if given, else it's kept as `url`. */
  const start = useCallback(async (onTake?: (url: string) => void) => {
    if (parts.current) return;
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError('The microphone isn\'t available.');
      return;
    }
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream);
    recorder.addEventListener('dataavailable', (e) => { if (e.data.size) chunks.push(e.data); });
    recorder.addEventListener('stop', () => {
      release();
      const made = URL.createObjectURL(new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' }));
      if (onTake) { onTake(made); return; }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = made;
      setUrl(made);
    });
    const p: { recorder: MediaRecorder; stream: MediaStream; ctx?: AudioContext; frame: number } = { recorder, stream, frame: 0 };
    parts.current = p;
    if (window.AudioContext) {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const size = Math.max(1, Math.floor(data.length / BARS));
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        setLevels(Array.from({ length: BARS }, (_, b) => Math.max(...Array.from(data.subarray(b * size, (b + 1) * size), (v) => Math.abs(v - 128) / 128))));
        p.frame = requestAnimationFrame(tick);
      };
      p.ctx = ctx;
      p.frame = requestAnimationFrame(tick);
    }
    recorder.start();
    setRecording(true);
  }, [release]);

  const stop = useCallback(() => {
    parts.current?.recorder.stop();
    setRecording(false);
  }, []);

  const reset = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setUrl(null);
  }, []);

  useEffect(() => () => { release(); if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, [release]);
  return { recording, url, levels, error, start, stop, reset };
}

type Recorder = ReturnType<typeof useRecorder>;

function Levels({ levels }: { levels: number[] }) {
  return (
    <div className="flex h-8 min-w-0 flex-1 items-center gap-0.5" aria-hidden>
      {levels.map((l, i) => <div key={i} className="flex-1 rounded-full bg-white" style={{ height: `${Math.max(8, Math.min(100, l * 160))}%` }} />)}
    </div>
  );
}

function PlayButton({ url, label }: { url: string; label: string }) {
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => { audio.current?.pause(); }, []);
  const toggle = () => {
    if (playing) { audio.current?.pause(); setPlaying(false); return; }
    audio.current = new Audio(url);
    audio.current.onended = () => setPlaying(false);
    void audio.current.play();
    setPlaying(true);
  };
  return (
    <button type="button" className={OUTLINE} onClick={toggle}>
      {playing ? <Square size={16} /> : <Play size={16} />} {label}
    </button>
  );
}

// ---------- the look (practice-style.md) ----------

const OUTLINE = 'flex items-center justify-center gap-2 rounded-lg border border-white px-4 py-3 text-white transition-colors duration-150 hover:bg-white/10 disabled:opacity-50';
const PRIMARY = `${OUTLINE} bg-white/30`;
const PLAIN = 'py-2 text-sm text-white/80 hover:text-white';

function Shell({ mode, progress, instruction, onBack, children }: { mode: string; progress?: number; instruction?: string; onBack?: () => void; children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto bg-linear-to-br from-primary via-secondary to-accent text-white">
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col gap-4 px-4 py-6">
        <div className="flex items-center justify-between gap-3">
          {onBack ? <button type="button" className="rounded-lg border border-white p-2 hover:bg-white/10" aria-label="Back" onClick={onBack}><ArrowLeft size={18} /></button> : <span />}
          <span className="text-sm font-medium">{mode}</span>
        </div>
        {progress !== undefined && (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/30">
            <div className="h-full rounded-full bg-white transition-[width] duration-300 ease-out" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
        {instruction && <p className="font-mono text-sm">{instruction}</p>}
        <div className="flex flex-1 flex-col gap-4">{children}</div>
      </div>
    </div>
  );
}

/** What you want to say, and (revealed) how it's said. */
function Phrase({ id, reveal }: { id: string; reveal: boolean }) {
  const card = useDoc('flashcard@1', id);
  if (!card) return <div className="flex flex-1 items-center justify-center"><span className="loading loading-spinner" /></div>;
  const context = str(card.value.context);
  const extra = str(card.value.extra);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <Markdown text={str(card.value.front)} className="text-2xl font-bold" />
      {context && <p className="text-sm text-white/80">{context}</p>}
      {reveal && (
        <>
          <div className="my-2 w-full border-t border-dashed border-white/60" />
          <Markdown text={str(card.value.back)} className="text-2xl font-bold" />
          {extra && <Markdown text={extra} className="text-sm text-white/80" />}
          <Credits sources={card.value.sources} className="mt-2 text-white" />
        </>
      )}
    </div>
  );
}

// ---------- rating ----------

function useRate(states: FsrsStates, put: (f: ReturnType<typeof facetOf>, s: Parameters<typeof saveReview>[3]) => void, log: PracticeLog) {
  const write = useWrite();
  const [error, setError] = useState<string | null>(null);
  const rate = useCallback(async (id: string, grade: Grade) => {
    const now = new Date();
    const f = facetOf(id);
    const prev = states.get(f);
    const next = { ...review(await getScheduler(), prev, grade, now), id: prev?.id };
    put(f, next);
    saveReview(write, f, prev, next, log).catch((e: unknown) => setError(message(e)));
    logPractice(write, id, VIEW, ratingOf(grade), now).catch((e: unknown) => setError(message(e)));
  }, [states, put, write, log]);
  const seen = useCallback((id: string) => {
    logPractice(write, id, VIEW, 0, new Date()).catch((e: unknown) => setError(message(e)));
  }, [write]);
  return { rate, seen, error, dismiss: () => setError(null) };
}

// ---------- recall: one phrase, from prompt to rating ----------

type Phase = 'recall' | 'check';

function Recall({ id, language, canRecord, recorder, onRated, progress, mode, onBack }: {
  id: string; language: string; canRecord: boolean; recorder: Recorder; progress: number; mode: string; onBack: () => void;
  onRated: (right: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>('recall');
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => { recorder.reset(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps -- a new phrase, a new take
  const check = () => { if (recorder.recording) recorder.stop(); setPhase('check'); };
  if (phase === 'recall') {
    return (
      <Shell mode={mode} progress={progress} instruction={`Do you remember how to say this in ${language}?`} onBack={onBack}>
        <Phrase id={id} reveal={false} />
        <div className="flex flex-col gap-3">
          {recorder.error && <p className="text-center text-sm">{recorder.error}</p>}
          {canRecord && recorder.recording && (
            <div className="flex items-center gap-3"><Levels levels={recorder.levels} /><button type="button" className={OUTLINE} aria-label="Stop recording" onClick={recorder.stop}><Check size={16} /></button></div>
          )}
          {canRecord && !recorder.recording && !recorder.url && <button type="button" className={PRIMARY} onClick={() => void recorder.start()}><Mic size={16} /> Say it</button>}
          {canRecord && recorder.url && (
            <div className="flex gap-3">
              <PlayButton url={recorder.url} label="Your take" />
              <button type="button" className={OUTLINE} aria-label="Record again" onClick={() => { recorder.reset(); void recorder.start(); }}><RotateCcw size={16} /></button>
            </div>
          )}
          <button type="button" className={canRecord && !recorder.url ? OUTLINE : PRIMARY} onClick={check}><ArrowRight size={16} /> {canRecord && recorder.url ? 'Check' : 'Reveal'}</button>
          <button type="button" className={PLAIN} onClick={() => { setGaveUp(true); check(); }}>I have no idea</button>
        </div>
      </Shell>
    );
  }
  return (
    <Shell mode={mode} progress={progress} instruction={gaveUp ? 'This is how it goes.' : 'Did you get it right?'} onBack={onBack}>
      <Phrase id={id} reveal />
      <div className="flex flex-col gap-3">
        {recorder.url && !gaveUp && <PlayButton url={recorder.url} label="Your take" />}
        {gaveUp ? (
          <button type="button" className={PRIMARY} onClick={() => onRated(false)}><ArrowRight size={16} /> Next</button>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <button type="button" className={OUTLINE} onClick={() => onRated(false)}><ThumbsDown size={16} /> Wrong</button>
            <button type="button" className={PRIMARY} onClick={() => onRated(true)}><ThumbsUp size={16} /> Right</button>
          </div>
        )}
      </div>
    </Shell>
  );
}

// ---------- the view ----------

export default function Phrasebook() {
  const [params, setParams] = useParams();
  const { graph, loading, error } = useGraph();
  const reviews = useAll(useQuery({ gestalt: 'fsrs-data@1', limit: 500 }));
  const stored = useMemo(() => fsrsStates(reviews.items), [reviews.items]);
  const { states, put } = useLocalReviews(stored);
  const log = usePracticeSession(VIEW);
  const rating = useRate(states, put, log);
  const { capabilities } = useCapabilities();
  const canRecord = !!capabilities?.microphone && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof MediaRecorder !== 'undefined';
  const recorder = useRecorder();
  const now = useNow();

  const lang = params.lang;
  const go = (p: Record<string, string | undefined>) => setParams(Object.fromEntries(Object.entries(p).filter((e): e is [string, string] => !!e[1])));
  const cards = useMemo(() => graph.cards.filter((c) => c.lang === lang), [graph.cards, lang]);
  const deck = graph.decks.find((d) => cards.some((c) => d.members.includes(c.id)));
  const conceptIds = useMemo(() => (deck ? deck.members.filter((m) => graph.concepts.has(m)) : null), [deck, graph.concepts]);
  const { beliefs } = useBeliefs(conceptIds);

  const alert = (error || rating.error) && (
    <div role="alert" className="alert alert-error text-sm">
      <span>{error ?? `Couldn't save your last answer: ${rating.error}`}</span>
      {rating.error && <button type="button" className="btn btn-sm btn-ghost" onClick={rating.dismiss}>Dismiss</button>}
    </div>
  );

  if (loading || reviews.loading || reviews.hasMore) return <div className="flex h-full items-center justify-center"><span className="loading loading-spinner" /></div>;

  if (!lang || !cards.length) {
    const langs = [...new Set(graph.cards.map((c) => c.lang))].sort();
    return (
      <Shell mode="Phrasebook" instruction={langs.length ? 'Which language?' : 'No phrase decks here yet.'}>
        {alert}
        {langs.map((l) => {
          const d = graph.decks.find((x) => graph.cards.some((c) => c.lang === l && x.members.includes(c.id)));
          return <button key={l} type="button" className={OUTLINE} onClick={() => go({ lang: l })}>{d?.title ?? graph.languageName(l)}</button>;
        })}
      </Shell>
    );
  }

  const language = graph.languageName(lang);
  const home = () => go({ lang });

  if (params.screen === 'lesson') return <Lesson key="lesson" cards={cards} states={states} beliefs={beliefs} language={language} canRecord={canRecord} recorder={recorder} onRate={rating.rate} onBack={home} alert={alert} />;
  if (params.screen === 'learn') return <Learn key="learn" cards={cards} states={states} beliefs={beliefs} graph={graph} language={language} canRecord={canRecord} recorder={recorder} onRate={rating.rate} onSeen={rating.seen} onBack={home} alert={alert} />;
  if (params.screen === 'progress') return <Progress lang={lang} language={language} graph={graph} cards={cards} beliefs={beliefs} onBack={home} />;

  const due = cards.filter((c) => isDue(states, c.id, now)).length;
  const learned = cards.filter((c) => states.has(facetOf(c.id))).length;
  const sources = [...new Map(cards.flatMap((c) => (Array.isArray(c.sources) ? c.sources : [])).map((s) => [JSON.stringify(s), s])).values()];
  return (
    <Shell mode={deck?.title ?? language} instruction={`${due} due · ${learned} learned · ${cards.length - learned} new`} onBack={() => go({})}>
      {alert}
      <div className="flex flex-1 flex-col justify-center gap-3">
        <button type="button" className={PRIMARY} disabled={!due} onClick={() => go({ lang, screen: 'lesson' })}>Practice</button>
        <button type="button" className={OUTLINE} disabled={learned === cards.length} onClick={() => go({ lang, screen: 'learn' })}>Learn new</button>
        <button type="button" className={OUTLINE} onClick={() => go({ lang, screen: 'progress' })}>What you can do</button>
      </div>
      {!canRecord && <p className="text-center text-xs text-white/70">Recording isn't available here: you'll reveal instead of saying it aloud.</p>}
      <Credits sources={sources} className="text-center text-white" />
    </Shell>
  );
}

type Practice = {
  cards: Card[]; states: FsrsStates; beliefs: Map<string, Belief>; language: string; canRecord: boolean; recorder: Recorder;
  onRate: (id: string, g: Grade) => Promise<void>; onBack: () => void; alert: ReactNode;
};

/** Due phrases, one way of saying each, the one where the gaps are; a miss comes back at the end. */
function Lesson({ cards, states, beliefs, language, canRecord, recorder, onRate, onBack, alert }: Practice) {
  // fixed when the lesson starts, so rating doesn't reshuffle it
  const [queue, setQueue] = useState(() => lessonPlan(cards, states, beliefs, new Date(), { max: LESSON_SIZE }).map((c) => c.id));
  const [total] = useState(queue.length);
  const [done, setDone] = useState(0);
  const [right, setRight] = useState(0);
  const missed = useRef(new Set<string>());
  if (!queue.length) {
    return (
      <Shell mode="Practice" progress={1} instruction={total ? `${right} of ${done} right the first time.` : 'Nothing due right now.'} onBack={onBack}>
        {alert}
        <div className="flex flex-1 items-center justify-center"><button type="button" className={PRIMARY} onClick={onBack}>Done</button></div>
      </Shell>
    );
  }
  const id = queue[0];
  const onRated = (ok: boolean) => {
    void onRate(id, ok ? Rating.Good : Rating.Again);
    if (!missed.current.has(id)) { setDone((d) => d + 1); if (ok) setRight((r) => r + 1); }
    if (!ok) missed.current.add(id);
    setQueue((q) => (ok || q.length === 1 ? q.slice(1) : [...q.slice(1), id]));
  };
  return <>{alert}<Recall key={`${id}:${queue.length}`} id={id} language={language} canRecord={canRecord} recorder={recorder} progress={total ? 1 - queue.length / total : 1} mode="Practice" onBack={onBack} onRated={onRated} /></>;
}

/** New phrases, those mostly made of what's known first: study one, say it, wait, recall it. */
function Learn({ cards, states, beliefs, graph, language, canRecord, recorder, onRate, onSeen, onBack, alert }: Practice & { graph: Graph; onSeen: (id: string) => void }) {
  const ranked = useMemo(() => rankNew(cards, states, beliefs), [cards, states, beliefs]);
  const [current, setCurrent] = useState<string | null>(() => ranked[0]?.item.id ?? null);
  const [step, setStep] = useState<'study' | 'wait' | 'recall'>('study');
  const [takes, setTakes] = useState<string[]>([]);
  // every take's URL, to let go of when leaving
  const made = useRef<string[]>([]);
  useEffect(() => () => made.current.forEach((u) => URL.revokeObjectURL(u)), []);
  const addTake = useCallback((u: string) => { made.current.push(u); setTakes((t) => [...t, u]); }, []);
  useEffect(() => {
    if (step !== 'wait') return;
    const t = setTimeout(() => setStep('recall'), WAIT_MS);
    return () => clearTimeout(t);
  }, [step]);

  if (!current) {
    return (
      <Shell mode="Learn" instruction="You've seen every phrase here." onBack={onBack}>
        {alert}
        <div className="flex flex-1 items-center justify-center"><button type="button" className={PRIMARY} onClick={onBack}>Done</button></div>
      </Shell>
    );
  }
  const entry = ranked.find((r) => r.item.id === current);
  const main = entry && mainConcept(entry.item.concepts);
  const why = entry?.strong.filter((c) => c !== main).map((c) => shortName(graph.concepts.get(c)?.name ?? c)) ?? [];
  const known = !!main && entry.strong.includes(main);

  if (step === 'study') {
    const ready = !canRecord || takes.length >= TAKES;
    return (
      <Shell mode="Learn" instruction={`Say the ${language} until you know it by heart.`} onBack={onBack}>
        {alert}
        <Phrase id={current} reveal />
        {(known || why.length > 0) && (
          <p className="text-center text-xs text-white/80">
            {known ? 'Another way to say something you know.' : 'You already know part of this:'} {why.length > 0 && why.join(', ')}
          </p>
        )}
        <div className="flex flex-col gap-3">
          {takes.map((u, i) => <PlayButton key={u} url={u} label={`Take ${i + 1}`} />)}
          {recorder.error && <p className="text-center text-sm">{recorder.error}</p>}
          {canRecord && recorder.recording && (
            <div className="flex items-center gap-3"><Levels levels={recorder.levels} /><button type="button" className={OUTLINE} aria-label="Stop recording" onClick={recorder.stop}><Check size={16} /></button></div>
          )}
          {canRecord && !recorder.recording && !ready && <button type="button" className={PRIMARY} onClick={() => void recorder.start(addTake)}><Mic size={16} /> Say it ({takes.length + 1} of {TAKES})</button>}
          {ready && <button type="button" className={PRIMARY} onClick={() => { onSeen(current); setStep('wait'); }}><Check size={16} /> Done</button>}
        </div>
      </Shell>
    );
  }
  if (step === 'wait') {
    return (
      <Shell mode="Learn" progress={0} instruction="Now from memory, in a moment." onBack={onBack}>
        <div className="flex flex-1 items-center justify-center"><span className="loading loading-dots loading-lg" /></div>
      </Shell>
    );
  }
  const next = () => {
    takes.forEach((u) => URL.revokeObjectURL(u));
    setTakes([]);
    setCurrent(ranked.find((r) => r.item.id !== current)?.item.id ?? null);
    setStep('study');
  };
  return (
    <>
      {alert}
      <Recall key={current} id={current} language={language} canRecord={canRecord} recorder={recorder} progress={0.5} mode="Learn" onBack={onBack}
              onRated={(ok) => { void onRate(current, ok ? Rating.Good : Rating.Again); next(); }} />
    </>
  );
}

// ---------- what you can do ----------

type Row = { id: string; label: string; belief?: Belief; also: string[] };

function Bar({ belief }: { belief?: Belief }) {
  const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
  const p = belief?.p ?? 0.5;
  const lo = belief ? sigmoid(belief.mean - belief.sd) : 0;
  const hi = belief ? sigmoid(belief.mean + belief.sd) : 1;
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/20" title={belief ? `${Math.round(p * 100)}% · from ${belief.evidence} answers` : 'nothing yet'}>
      <div className="absolute inset-y-0 bg-white/30" style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }} />
      <div className="absolute inset-y-0 left-0 rounded-full bg-white" style={{ width: `${p * 100}%` }} />
    </div>
  );
}

function Section({ title, rows }: { title: string; rows: Row[] }) {
  if (!rows.length) return null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-mono text-sm">{title}</h2>
      {rows.map((r) => (
        <div key={r.id} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span>{r.label}</span>
            <span className="text-xs text-white/70">{r.belief?.evidence ? `${r.belief.evidence}×` : 'not yet'}{r.also.length > 0 && ` · also ${r.also.join(', ')}`}</span>
          </div>
          <Bar belief={r.belief} />
        </div>
      ))}
    </section>
  );
}

/**
 * The language's concepts as the app believes they're known: what you can do (functions), where (situations), the
 * pieces of the language (pronouns, registers), and what's shared with every language, each with the other languages
 * whose phrases reach it.
 */
function Progress({ lang, language, graph, cards, beliefs, onBack }: { lang: string; language: string; graph: Graph; cards: Card[]; beliefs: Map<string, Belief>; onBack: () => void }) {
  const rows = useMemo(() => {
    const intents = new Set(cards.flatMap((c) => mainConcept(c.concepts) ?? []));
    const langOf = (conceptId: string) => graph.concepts.get(conceptId)?.name.split(':')[0];
    const ours = new Set(graph.decks.filter((d) => cards.some((c) => d.members.includes(c.id))).flatMap((d) => d.members));
    const row = (id: string): Row => {
      const others = graph.links.filter((l) => l.to === id && langOf(l.from) !== lang).map((l) => langOf(l.from)).filter((x): x is string => !!x && x.length === 3);
      return { id, label: shortName(graph.concepts.get(id)?.name ?? id), belief: beliefs.get(id), also: [...new Set(others)].map(graph.languageName) };
    };
    const byStrength = (a: Row, b: Row) => (b.belief?.p ?? 0) - (a.belief?.p ?? 0) || a.label.localeCompare(b.label);
    const of = (test: (name: string, id: string) => boolean) => [...graph.concepts.values()].filter((c) => ours.has(c.id) && test(c.name, c.id)).map((c) => row(c.id)).sort(byStrength);
    return {
      functions: of((n) => n.startsWith('function: ')),
      situations: of((n) => n.startsWith('situation: ')),
      pieces: of((n, id) => n.startsWith(`${lang}: `) && !intents.has(id)),
      shared: of((n) => n.startsWith('social: ')),
      phrases: of((_, id) => intents.has(id)),
      language: of((n) => n === `lang: ${lang}`).map((r) => ({ ...r, label: language })),
    };
  }, [lang, language, graph, cards, beliefs]);
  return (
    <Shell mode="What you can do" instruction={`In ${language}, estimated from everything you practised.`} onBack={onBack}>
      <Section title={language} rows={rows.language} />
      <Section title="What you can do" rows={rows.functions} />
      <Section title="Where" rows={rows.situations} />
      <Section title={`Pieces of ${language}`} rows={rows.pieces} />
      <Section title="In every language" rows={rows.shared} />
      <Section title="Phrases" rows={rows.phrases} />
    </Shell>
  );
}
