import { useEffect, useRef, useState } from 'react';
import { Ban, SkipForward } from 'lucide-react';
import { asMap, definePane, definePerspective, useHost, withTag, type JsonMap, type Query, type Repo } from '@gestalts/sdk';
import { ALL_MODES, LlmUnavailable, ModelDownload, Note, NotePicker, OLLAMA_SERVICE, addRelation, type NoteMode } from '@gestalts/kit';
import { MODEL, NO_QUESTIONS_TAG, POOL, fallback, isCandidate, noteText, pick, randomKey, type Question } from './questions';

/** The note asked about, and those skipped this session, kept outside the pane so they stay while other tabs are open. */
let current: string | null = null;
const skipped = new Set<string>();

const MODE_KEY = 'gestalts-questions-mode';

function storedMode(): NoteMode {
  try {
    const m = sessionStorage.getItem(MODE_KEY);
    return ALL_MODES.includes(m as NoteMode) ? (m as NoteMode) : 'view';
  } catch { return 'view'; }
}

function forPane(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  const typing = t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
  return !typing && !e.metaKey && !e.ctrlKey && !e.altKey && !document.querySelector('dialog[open]');
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Writes `change` of the note's value. */
async function change(repo: Repo, key: string, f: (v: JsonMap) => JsonMap) {
  const n = repo.get(key);
  const v = asMap(n?.value ?? null);
  if (!n || !v) throw new Error(n ? `${key} does not parse; fix its YAML first.` : `No note ${key}`);
  const next = f(v);
  if (next !== v) await repo.putValue(key, next);
}

type Picked =
  | { state: 'picking' }
  | { state: 'done'; questions: Question[]; reason?: string; missingModel?: string | null };

/**
 * A random note of yours that states something (`>` or `~` in its text) and is linked loosely (at most one
 * relationship), with up to 3 questions about it. A local LLM (`ollama@1`) picks them when there is one; otherwise the
 * first ones are asked. An answer relates the note, under the question's label, to a note picked or made from the
 * text typed. Skip (`s`) shows another, Disable (`d`) tags it `no-questions`, `e` edits it.
 */
const Questions = definePerspective<{ pool: Query }, object, { llm: string }>({
  id: 'questions',
  title: 'Questions',
  data: { pool: POOL },
  services: { llm: OLLAMA_SERVICE },
  Component: ({ data, repo, services }) => {
    const onOpen = useHost().openNote;
    const [, setShown] = useState(0);
    const [mode, setModeState] = useState(storedMode);
    const [error, setError] = useState<string | null>(null);
    const setMode = (m: NoteMode) => {
      setModeState(m);
      try { sessionStorage.setItem(MODE_KEY, m); } catch { /* not remembered */ }
    };

    const candidates = data.pool.filter(isCandidate).map((n) => n.key);
    const show = (key: string | null) => { current = key; setError(null); setShown((s) => s + 1); };
    const next = () => show(randomKey(candidates, new Set([...skipped, ...(current ? [current] : [])])));
    // the first note waits for notes to draw from; a deleted one is replaced. One that's answered stays until Skip.
    if ((current === null || !repo.get(current)) && candidates.length) current = randomKey(candidates, skipped);
    const key = current && repo.get(current) ? current : null;

    // the questions, picked once per note shown
    const llm = services.llm;
    const address = llm ? `${llm.baseUrl}/${llm.id}` : null;
    const client = useRef(llm);
    useEffect(() => { client.current = llm; });
    const [retry, setRetry] = useState(0);
    const [picked, setPicked] = useState<{ key: string; picked: Picked } | null>(null);
    useEffect(() => {
      if (!key) return;
      const note = repo.get(key);
      if (!note) return;
      const abort = new AbortController();
      setPicked({ key, picked: { state: 'picking' } });
      pick(client.current, noteText(note), abort.signal).then(
        (questions) => setPicked({ key, picked: { state: 'done', questions } }),
        (e: unknown) => {
          if (abort.signal.aborted) return;
          setPicked({ key, picked: { state: 'done', questions: fallback(), reason: message(e), missingModel: e instanceof LlmUnavailable ? e.missingModel : null } });
        },
      );
      return () => abort.abort();
      // eslint-disable-next-line react-hooks/exhaustive-deps -- `address` stands for the client; a note's edits don't pick again
    }, [key, address, retry]);
    const shown = picked?.key === key ? picked.picked : { state: 'picking' as const };

    const skip = () => { if (key) skipped.add(key); next(); };
    const disable = async () => {
      if (!key) return;
      try {
        await change(repo, key, (v) => asMap(withTag(v, NO_QUESTIONS_TAG, true))!);
        next();
      } catch (e) { setError(message(e)); }
    };

    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (!key || !forPane(e)) return;
        if (e.key === 's') skip();
        else if (e.key === 'd') void disable();
        else if (e.key === 'e') setMode('edit');
        else return;
        e.preventDefault();
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    });

    if (!key) return <p className="mx-auto max-w-4xl p-3 text-base-content/50">No notes to ask about.</p>;

    const answer = async (label: string, target: { key: string } | { text: string }) => {
      try {
        const other = 'key' in target ? repo.get(target.key) : await repo.putValue(undefined, { main: target.text });
        if (!other) throw new Error('That note is gone.');
        await change(repo, key, (v) => addRelation(v, other.id, label));
        setError(null);
      } catch (e) { setError(message(e)); }
    };

    const status = shown.state !== 'done' ? null
      : shown.missingModel ? `${shown.missingModel} isn't installed, asking the first ones.`
      : shown.reason ? `No local LLM to pick the questions, asking the first ones: ${shown.reason}`
      : !shown.questions.length ? 'No question fits this note.'
      : null;

    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-4 p-3">
        <div className="flex items-center gap-1">
          <button type="button" className="btn" title="another note (s)" onClick={skip}><SkipForward className="size-5" />Skip</button>
          <button type="button" className="btn" title={`never ask about this note: tag it ${NO_QUESTIONS_TAG} (d)`} onClick={() => void disable()}>
            <Ban className="size-5" />Disable
          </button>
          <span className="ml-auto font-mono text-xs text-base-content/50" title="notes to ask about">{candidates.length}</span>
        </div>
        <Note key={key} noteKey={key} mode={mode} onModeChange={setMode} onOpen={onOpen} onDeleted={next}
              className="rounded-box border border-base-300 p-4" />
        {error && <div role="alert" className="alert alert-error text-sm">{error}</div>}
        {shown.state === 'picking' && <span className="loading loading-dots loading-sm" aria-label="picking the questions" />}
        {status && (
          <p className="flex flex-wrap items-center gap-2 text-sm text-base-content/50">
            {status}
            {shown.state === 'done' && shown.missingModel && (
              <ModelDownload llm={llm} model={MODEL} onInstalled={() => setRetry((r) => r + 1)} />
            )}
          </p>
        )}
        {shown.state === 'done' && shown.questions.map((q) => (
          <div key={`${key}:${q.id}`}>
            <p className="mb-1 font-medium">{q.question}</p>
            <NotePicker limit={5} exclude={[key]} placeholder="Link a note, or type a new one"
                        onPick={(other) => void answer(q.label, { key: other })} onCreate={(text) => void answer(q.label, { text })} />
          </div>
        ))}
      </div>
    );
  },
});

export const QuestionsPane = definePane({ title: 'Questions', Component: () => <Questions /> });
