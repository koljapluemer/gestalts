import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { logPractice, usePracticeSession, type EventRating, type PracticeLog } from '@gestalts/learning';
import { useBeliefs, useDoc, useQuery, useViewState, useWrite, type QueryResult } from '@gestalts/view';

/**
 * Type Vietnamese words as shown, three a line, with the system's Vietnamese keyboard: sam-learns-things'
 * typingpractice (from linguanodon's), its practice loop ported as it is (`typingSession`, `LineView`, the page).
 * What differs: lines are drawn by how weak their words' marks are (the item model's response concepts,
 * `useBeliefs`), never a word on screen again; each finished line logs a practice event per word on its
 * `typing-word@1` (+1 right, −1 not, naming the first mark it lacks as the response, 0 with keystroke hints shown) and
 * a trial, instead of a line attempt; the keystroke method is picked here, not on a settings page.
 */

const VIEW = 'vietnamese-typing-practice';
const TAG = 'vietnamese-typing-practice';
const MODEL = 'item-model-vietnamese-typing-practice-type-the-word';
const WORDS_PER_LINE = 3;
const IDLE_TIMEOUT_MS = 10000;
/** a word without marks, or with marks all known, still comes up this much */
const BASE_WEIGHT = 0.2;

export type Method = 'off' | 'telex' | 'vni';
type Mark = { at: number; mark: string; key: string };
type Word = { id: string; text: string; gloss: string; keys: { telex: string; vni: string }; marks: Mark[] };

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Every page of a query: words are drawn from all of them. */
function useAll(result: QueryResult): QueryResult {
  const { hasMore, more, items } = result;
  useEffect(() => { if (hasMore) more(); }, [hasMore, more, items.length]);
  return result;
}

/** Whether the letter typed for a mark's position has it. */
export const hasMark = (typed: string | undefined, m: Mark) => !!typed && typed.toLowerCase().normalize('NFD').includes(m.mark);

/** The first mark of a word not in what was typed for it, by key. */
export function missingMark(word: Pick<Word, 'marks'>, typed: string): string | undefined {
  return word.marks.find((m) => !hasMark(typed[m.at], m))?.key;
}

/** `count` different words, none of `avoid`, each drawn by its weight. */
export function drawLine<W extends { id: string }>(words: W[], weight: (w: W) => number, avoid: Set<string>, count: number, random = Math.random): W[] {
  let pool = words.filter((w) => !avoid.has(w.id));
  if (pool.length < count) pool = [...words];
  const out: W[] = [];
  while (out.length < count && pool.length) {
    const weights = pool.map(weight);
    let r = random() * weights.reduce((a, b) => a + b, 0);
    let i = 0;
    while (i < pool.length - 1 && r >= weights[i]) r -= weights[i++];
    out.push(pool[i]);
    pool = pool.filter((_, j) => j !== i);
  }
  return out;
}

// ---------- the practice loop (useTypingSession) ----------

export type SessionView<W> = { currentLine: W[]; nextLine: W[]; inputValue: string };
export type SessionStats = { wpm: number; accuracy: number; elapsedSeconds: number };

/**
 * The original's practice loop, its state and steps as they were; only where lines come from (`nextChunk`, given
 * the lines on screen to avoid) and what a finished line records (`onLine`, with its active ms) are passed in.
 * `handleInput` says whether the line advanced, so the field can be emptied.
 */
export function typingSession<W extends { text: string }>({ nextChunk, onLine, now = Date.now, hidden = () => document.hidden }: {
  nextChunk: (onScreen: W[]) => W[];
  onLine: (line: W[], value: string, ms: number) => void;
  now?: () => number;
  hidden?: () => boolean;
}) {
  let inputValue = '';
  let currentLine: W[] = [];
  let nextLine: W[] = [];
  let target = '';
  let totalChars = 0;
  let mistakes = 0;
  let completedWords = 0;

  // Timer: accumulates only while the tab is visible and typing is active.
  let elapsedMs = 0;
  let runStart: number | null = null;
  let lastKeyTime = 0;
  let lastLineElapsedMs = 0;

  function resumeTimer(): void {
    if (runStart === null && !hidden()) runStart = now();
  }

  function pauseTimer(): void {
    if (runStart !== null) {
      elapsedMs += now() - runStart;
      runStart = null;
    }
  }

  function currentElapsedMs(): number {
    return elapsedMs + (runStart !== null ? now() - runStart : 0);
  }

  function tick(): SessionStats {
    if (runStart !== null && now() - lastKeyTime > IDLE_TIMEOUT_MS) pauseTimer();
    const elapsedMin = currentElapsedMs() / 60000;
    const typedInLine = inputValue.trim().length > 0 ? inputValue.trim().split(/\s+/).length : 0;
    const typedWords = completedWords + typedInLine;
    return {
      wpm: elapsedMin > 0 ? Math.round(typedWords / elapsedMin) : 0,
      accuracy: totalChars > 0 ? Math.max(0, Math.round(((totalChars - mistakes) / totalChars) * 100)) : 100,
      elapsedSeconds: Math.round(currentElapsedMs() / 1000),
    };
  }

  // Scored once, from the final settled value, when a line completes - never accumulated keystroke by keystroke. A
  // letter that took several revisions to reach its correct form is graded once, as whatever it ended up being.
  function scoreLine(value: string): void {
    for (let i = 0; i < target.length; i++) {
      totalChars++;
      if (value[i] !== target[i]) mistakes++;
    }
  }

  function advanceLine(value: string): void {
    scoreLine(value);
    const nowElapsedMs = currentElapsedMs();
    onLine(currentLine, value, Math.max(0, nowElapsedMs - lastLineElapsedMs));
    lastLineElapsedMs = nowElapsedMs;

    completedWords += currentLine.length;
    currentLine = nextLine;
    nextLine = nextChunk(currentLine);
    target = currentLine.map((w) => w.text).join(' ');
    inputValue = '';
  }

  // 'input' fires reliably on every change regardless of how it got there - unlike keydown, which reports e.key as
  // the opaque value "Process" for the physical keys involved while an IME is composing.
  function handleInput(value: string, isComposing: boolean): boolean {
    lastKeyTime = now();
    resumeTimer();
    inputValue = value;
    if (isComposing) return false;
    if (value.length >= target.length) {
      advanceLine(value);
      return true;
    }
    return false;
  }

  /** the first two lines, as onMounted drew them */
  function start(): void {
    currentLine = nextChunk([]);
    nextLine = nextChunk(currentLine);
    target = currentLine.map((w) => w.text).join(' ');
  }

  return {
    start,
    handleInput,
    tick,
    pauseTimer,
    view: (): SessionView<W> => ({ currentLine, nextLine, inputValue }),
  };
}

// ---------- the look (renderLine) ----------

// Pure function of a line's words and the current field value - no memory of prior renders. However the value got to
// its current state (real IME composition, or a tool that edits already-typed characters in place), this always
// reflects what's true right now.
function LineView({ lineWords, typed, active, method }: { lineWords: Word[]; typed: string; active: boolean; method: Method }) {
  const offsets = lineWords.map((_, i) => lineWords.slice(0, i).reduce((n, w) => n + w.text.length + 1, 0));
  return (
    <div className="flex justify-center gap-8">
      {lineWords.map((w, wi) => {
        const chars = [];
        for (let i = 0; i < w.text.length; i++) {
          const idx = offsets[wi] + i;
          const char = w.text[i];
          const cls = active && idx < typed.length ? (typed[idx] === char ? 'text-success' : 'text-error underline')
            : active && idx === typed.length ? 'bg-primary/30 rounded' : 'text-base-content/40';
          chars.push(<span key={i} className={cls}>{char}</span>);
        }
        return (
          <div key={w.id} className="flex flex-col items-center gap-1">
            <span className="font-mono text-2xl tracking-wide">{chars}</span>
            <span className="text-xs opacity-60">{w.gloss}</span>
            {method !== 'off' && <span className="badge badge-ghost badge-sm font-mono">{w.keys[method]}</span>}
          </div>
        );
      })}
    </div>
  );
}

// ---------- the page (PagePractice) ----------

function Practice({ words, weightOf, method, log }: { words: Word[]; weightOf: (w: Word) => number; method: Method; log: PracticeLog }) {
  const write = useWrite();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<SessionView<Word>>({ currentLine: [], nextLine: [], inputValue: '' });
  const [stats, setStats] = useState<SessionStats>({ wpm: 0, accuracy: 100, elapsedSeconds: 0 });
  // the loop reads these as they are when it draws a line or finishes one
  const latest = useRef({ words, weightOf, method, write, log });
  useEffect(() => { latest.current = { words, weightOf, method, write, log }; }, [words, weightOf, method, write, log]);

  useEffect(() => { if (view.currentLine.length) log.shown(); }, [view.currentLine, log]);

  // onMounted: the loop, its first lines, the field's `input`, the tick and the tab's visibility; onUnmounted undoes them
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const session = typingSession<Word>({
      nextChunk: (onScreen) => drawLine(latest.current.words, latest.current.weightOf, new Set(onScreen.map((w) => w.id)), WORDS_PER_LINE),
      onLine: (line, value, ms) => record(line, value, ms),
    });
    const record = (line: Word[], value: string, ms: number) => {
      const { method: m, write: w, log: l } = latest.current;
      const now = new Date();
      const letters = line.reduce((n, word) => n + word.text.length, 0);
      let offset = 0;
      for (const word of line) {
        const typed = value.slice(offset, offset + word.text.length);
        offset += word.text.length + 1;
        const right = typed === word.text;
        const rating: EventRating = m !== 'off' ? 0 : right ? 1 : -1;
        const response = right ? undefined : missingMark(word, typed);
        // the line's active time, shared by its words by their length
        const wordMs = letters ? (ms * word.text.length) / letters : 0;
        logPractice(w, word.id, VIEW, rating, now, { ms: wordMs, ...(response ? { response } : {}) }).catch((e: unknown) => setError(message(e)));
        void l.trial({ kind: 'typed-word', target: word.id, rating });
      }
    };
    session.start();
    setView(session.view());

    const onInput = (event: Event) => {
      if (session.handleInput(el.value, (event as InputEvent).isComposing ?? false)) el.value = '';
      setView(session.view());
    };
    const tickInterval = setInterval(() => setStats(session.tick()), 500);
    const handleVisibilityChange = () => { if (document.hidden) session.pauseTimer(); };
    el.addEventListener('input', onInput);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      el.removeEventListener('input', onInput);
      clearInterval(tickInterval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return (
    <div className="flex flex-col items-center justify-center gap-6 p-4">
      {error && (
        <div role="alert" className="alert alert-error max-w-3xl">
          <span>Couldn't save your last line: {error}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <div className="stats shadow bg-base-100">
        <div className="stat place-items-center">
          <div className="stat-title">WPM</div>
          <div className="stat-value text-primary">{stats.wpm}</div>
        </div>
        <div className="stat place-items-center">
          <div className="stat-title">Accuracy</div>
          <div className="stat-value text-secondary">{stats.accuracy}%</div>
        </div>
        <div className="stat place-items-center">
          <div className="stat-title">Time</div>
          <div className="stat-value">{`${stats.elapsedSeconds}s`}</div>
        </div>
      </div>

      <div className="card bg-base-100 shadow-xl w-full max-w-3xl">
        <div className="card-body">
          <div className="flex flex-col gap-6 select-none">
            <LineView lineWords={view.currentLine} typed={view.inputValue} active method={method} />
            <LineView lineWords={view.nextLine} typed="" active={false} method={method} />
          </div>
        </div>
      </div>

      <input ref={inputRef} type="text" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
             className="input input-bordered input-lg w-full max-w-3xl text-center" placeholder="Start typing..." autoFocus />
    </div>
  );
}

// ---------- the view ----------

const METHODS: { value: Method; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'telex', label: 'TELEX' },
  { value: 'vni', label: 'VNI' },
];

export default function VietnameseTypingPractice() {
  const log = usePracticeSession(VIEW);
  const [method, setMethod] = useViewState<Method>('method', 'off');
  const wordItems = useAll(useQuery({ gestalt: 'typing-word@1', tags: { all: [TAG] }, fields: ['text', 'gloss', 'keystrokes', 'marks'], limit: 500 }));
  const model = useDoc('item-model@1', MODEL);
  const words = useMemo(() => wordItems.items.map((i): Word => {
    const keys = (i.value.keystrokes ?? {}) as Record<string, unknown>;
    return {
      id: i.id, text: str(i.value.text), gloss: str(i.value.gloss), keys: { telex: str(keys.telex), vni: str(keys.vni) },
      marks: (Array.isArray(i.value.marks) ? i.value.marks : []) as Mark[],
    };
  }).filter((w) => w.text), [wordItems.items]);

  // each mark's concept, from the item model's responses: what to ask beliefs about
  const markConcept = useMemo(() => {
    const responses = (model?.value.responses ?? {}) as Record<string, { concepts?: Record<string, number> }>;
    return new Map(Object.entries(responses).flatMap(([key, r]) => Object.keys(r.concepts ?? {}).slice(0, 1).map((c) => [key, c] as const)));
  }, [model]);
  const { beliefs } = useBeliefs(markConcept.size ? [...markConcept.values()] : null);
  const weightOf = useCallback((w: Word) => BASE_WEIGHT + [...new Set(w.marks.map((m) => m.key))]
    .reduce((sum, key) => sum + 1 - (beliefs.get(markConcept.get(key) ?? '')?.p ?? 0.5), 0), [beliefs, markConcept]);
  // the next line is drawn with the beliefs as they are then
  const weightRef = useRef(weightOf);
  useEffect(() => { weightRef.current = weightOf; }, [weightOf]);
  const liveWeight = useCallback((w: Word) => weightRef.current(w), []);

  const loaded = !wordItems.loading && !wordItems.hasMore;

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex flex-col items-center gap-2 p-4">
        <span className="text-sm opacity-70">Keystroke input method</span>
        <div className="join">
          {METHODS.map((option) => (
            <button key={option.value} type="button" className={`btn join-item ${method === option.value ? 'btn-primary' : ''}`}
                    onClick={() => setMethod(option.value)}>{option.label}</button>
          ))}
        </div>
      </div>
      {!loaded ? (
        <div className="flex min-h-64 items-center justify-center w-full"><span className="loading loading-spinner loading-lg" /></div>
      ) : words.length < WORDS_PER_LINE * 2 ? (
        <div className="alert alert-error max-w-3xl mx-auto"><span>No words to practise.</span></div>
      ) : (
        <Practice words={words} weightOf={liveWeight} method={method} log={log} />
      )}
    </div>
  );
}
