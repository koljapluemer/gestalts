import { INLINE, relationships, str, type IndexedNote, type Query, type ServiceClient } from '@gestalts/sdk';
import { LlmUnavailable, ollamaChat } from '@gestalts/kit';

export type Question = { id: string; question: string; label: string };

/** Asked about a note; an answer relates it to another note under `label`. */
export const QUESTIONS: Question[] = [
  { id: 'experts', question: 'Who would be the experts on this?', label: 'experts on this:' },
  { id: 'solves', question: 'What problem does this solve?', label: 'solves' },
  { id: 'does-not-solve', question: "What doesn't this solve?", label: 'does not solve' },
  { id: 'so-what', question: 'So what?', label: 'so:' },
  { id: 'assumes', question: 'What does this assume?', label: 'assumes' },
  { id: 'money-bet', question: 'Would I bet money on this being true?', label: 'money-bet test:' },
  { id: 'matters', question: 'Why does this matter?', label: 'matters b/c' },
  { id: 'paradigm', question: 'What paradigm(s) is this based on?', label: 'paradigm:' },
  { id: 'leads-to', question: 'Where does this lead to?', label: 'leads to' },
  { id: 'if-not-true', question: "What if this isn't true?", label: 'if not true' },
  { id: 'testable', question: 'How can I test this?', label: 'testable via' },
];

/** How many questions are asked per note; the LLM picks them when there are more. */
export const ASK_COUNT = 3;

/** Tuned together with `PROMPT`: small, fast without a GPU, and it keeps to the reply format. */
export const MODEL = 'gemma3:4b';

export const PROMPT = `You help someone enrich a personal knowledge base of short notes. Each note may be linked to other notes by answering questions about it.

You get one note and a numbered list of candidate questions, each with an id. Choose the questions that make the most sense to ask about this particular note: ones that a thoughtful reader could answer and whose answer would be a meaningful link to another note. Skip questions that are nonsensical or irrelevant for the note's content.

Return the ids of the chosen questions, best first, at most the requested number. Return fewer if fewer make sense.`;

/** The tag Disable puts on a note, so it's never asked about again. */
export const NO_QUESTIONS_TAG = 'no-questions';

/** `main` must contain one of these for a note to be asked about: it states something. */
const BODY_MARKERS = ['>', '~'];
/** A note with more relationships is linked well enough. */
const MAX_RELATIONS = 1;

/**
 * The notes Questions draws from: your own notes, as Queue's pool (minus its explorations), not tagged `no-questions`.
 * `isCandidate` narrows them further.
 */
export const POOL: Query = {
  gestaltsNone: [
    'appointment@1', 'recurring@1', 'source@1', 'daily@1',
    'fsrs-state@1', 'practice-state@1', 'practice-session@1', 'settings@1', 'plugin-install@1', 'conflict@1',
    'country@1', 'term@1', 'sentence@1', 'scene-object@1', 'interaction@1', 'flashcard@1', 'pronunciation-card@1', 'quote@1',
  ],
  tagsNone: [NO_QUESTIONS_TAG, 'retired'],
};

/** Loosely linked and stating something: `main` has `>` or `~`, and at most one relationship besides its inline links. */
export function isCandidate(n: IndexedNote): boolean {
  const main = str(n, 'main') ?? '';
  return BODY_MARKERS.some((m) => main.includes(m))
    && relationships(n).filter((r) => r.label !== INLINE).length <= MAX_RELATIONS;
}

/** A random key of `keys`, preferring ones not in `avoid`; null when there are none. */
export function randomKey(keys: readonly string[], avoid: ReadonlySet<string>, random: () => number = Math.random): string | null {
  const fresh = keys.filter((k) => !avoid.has(k));
  const pool = fresh.length ? fresh : keys;
  return pool.length ? pool[Math.floor(random() * pool.length)] : null;
}

/** What the LLM reads of a note. */
export function noteText(n: IndexedNote): string {
  return [str(n, 'title'), str(n, 'main')].filter((s) => s?.trim()).join('\n\n');
}

const ids = QUESTIONS.map((q) => q.id);

export const byId = (id: string) => QUESTIONS.find((q) => q.id === id);

/**
 * The known ids in the reply, in order, at most `ASK_COUNT`: from `{"ids": [...]}` when it's that JSON, else wherever
 * they appear in the text (models don't all keep to the schema). A reply naming none throws.
 */
export function idsIn(reply: string): string[] {
  let found: unknown;
  try { found = (JSON.parse(reply) as { ids?: unknown } | null)?.ids; } catch { found = undefined; }
  if (!Array.isArray(found)) {
    const alternatives = [...ids].sort((a, b) => b.length - a.length).map((i) => i.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    found = [...reply.matchAll(new RegExp(`(?<![\\w-])(${alternatives.join('|')})(?![\\w-])`, 'g'))].map((m) => m[1]);
    if (!(found as string[]).length) throw new LlmUnavailable(`unexpected reply: ${JSON.stringify(reply.slice(0, 100))}`);
  }
  return [...new Set((found as unknown[]).filter((i): i is string => typeof i === 'string' && ids.includes(i)))].slice(0, ASK_COUNT);
}

/** What `pick` asks the model, besides the prompt. */
export function pickRequest(text: string): string {
  const listing = QUESTIONS.map((q) => `- ${q.id}: ${q.question}`).join('\n');
  return `Questions:\n${listing}\n\nNote:\n${text}\n\nChoose at most ${ASK_COUNT}. Answer with JSON only, like {"ids": ["<id>", ...]}.`;
}

const SCHEMA = {
  type: 'object',
  properties: { ids: { type: 'array', items: { type: 'string', enum: ids }, maxItems: ASK_COUNT } },
  required: ['ids'],
};

/** The questions asked when there's no LLM to pick them. */
export const fallback = (): Question[] => QUESTIONS.slice(0, ASK_COUNT);

/** Picks by note text, for this page's life: the model's answer for the same text won't change. */
const cache = new Map<string, Question[]>();

/**
 * Up to `ASK_COUNT` questions that suit the note best, best first; possibly none. With no more than `ASK_COUNT`
 * questions there's nothing to choose and the LLM isn't asked. Throws `LlmUnavailable`.
 */
export async function pick(llm: ServiceClient | undefined, text: string, signal?: AbortSignal): Promise<Question[]> {
  if (QUESTIONS.length <= ASK_COUNT) return [...QUESTIONS];
  const hit = cache.get(text);
  if (hit) return hit;
  const reply = await ollamaChat(llm, { model: MODEL, system: PROMPT, user: pickRequest(text), schema: SCHEMA }, signal);
  const chosen = idsIn(reply).map((id) => byId(id)!);
  cache.set(text, chosen);
  return chosen;
}
