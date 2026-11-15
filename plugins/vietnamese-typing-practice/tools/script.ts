// What a mark of written Vietnamese is, and how it is typed: the only place that knows (the view reads both from the
// deck). Ported from sam-learns-things' typingpractice (from linguanodon's typingpractice/static/.../js/main.js).
//
// NFD splits a precomposed letter ("ệ") into its base letter and combining marks, so small tables of marks do instead
// of one entry per letter. A shape mark (â ă ơ, …) is typed at its letter. The tone key isn't: TELEX and VNI both type
// it at the end of the vowel run, before a trailing consonant ("tiếng" → "ti" + "ee" + "s" + "ng").

export type Method = 'telex' | 'vni';

const CIRCUMFLEX = '̂';
const BREVE = '̆';
const HORN = '̛';
const GRAVE = '̀';
const ACUTE = '́';
const TILDE = '̃';
const HOOK_ABOVE = '̉';
const DOT_BELOW = '̣';
const D_BAR = 'đ';

/** each tone mark by its Vietnamese name, which is its concept's and its response's */
const TONES: Record<string, string> = { [GRAVE]: 'huyền', [ACUTE]: 'sắc', [HOOK_ABOVE]: 'hỏi', [TILDE]: 'ngã', [DOT_BELOW]: 'nặng' };
const SHAPES = new Set([CIRCUMFLEX, BREVE, HORN]);
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);

const TELEX_TONE: Record<string, string> = { [GRAVE]: 'f', [ACUTE]: 's', [HOOK_ABOVE]: 'r', [TILDE]: 'x', [DOT_BELOW]: 'j' };
const VNI_TONE: Record<string, string> = { [GRAVE]: '2', [ACUTE]: '1', [HOOK_ABOVE]: '3', [TILDE]: '4', [DOT_BELOW]: '5' };

/** Every mark there is, by key: the five tones, then the letters made with a shape mark, and đ. */
export const MARK_KEYS = ['sắc', 'huyền', 'hỏi', 'ngã', 'nặng', 'ă', 'â', 'ê', 'ô', 'ơ', 'ư', 'đ'] as const;
export type MarkKey = (typeof MARK_KEYS)[number];

/**
 * A mark at position `at` of a word: `mark` is what the typed letter must contain, lowercased and decomposed (NFD),
 * for the mark to be there (a combining mark, or `đ`, which doesn't decompose); `key` names it.
 */
export type Mark = { at: number; mark: string; key: MarkKey };

type Letter = { base: string; shape: string; tone: string; dBar: boolean };

function letter(ch: string): Letter {
  if (ch.toLowerCase() === D_BAR) return { base: ch, shape: '', tone: '', dBar: true };
  const [base, ...marks] = ch.normalize('NFD');
  return { base, shape: marks.find((m) => SHAPES.has(m)) ?? '', tone: marks.find((m) => m in TONES) ?? '', dBar: false };
}

/** The marks of `text` (NFC), in order: at each letter its shape (or đ) first, then its tone. */
export function marksOf(text: string): Mark[] {
  if (text !== text.normalize('NFC')) throw new Error(`not NFC: ${text}`);
  const out: Mark[] = [];
  Array.from(text).forEach((ch, at) => {
    const l = letter(ch);
    if (l.dBar) out.push({ at, mark: D_BAR, key: 'đ' });
    if (l.shape) out.push({ at, mark: l.shape, key: (l.base.toLowerCase() + l.shape).normalize('NFC') as MarkKey });
    if (l.tone) out.push({ at, mark: l.tone, key: TONES[l.tone] as MarkKey });
  });
  for (const m of out) if (!MARK_KEYS.includes(m.key)) throw new Error(`${text}: no such mark ${m.key}`);
  return out;
}

/** each mark's share of a word's marks: what typing the word practises of each */
export function markShares(text: string): Map<MarkKey, number> {
  const marks = marksOf(text);
  const shares = new Map<MarkKey, number>();
  for (const m of marks) shares.set(m.key, (shares.get(m.key) ?? 0) + 1);
  for (const [k, n] of shares) shares.set(k, Math.round((n / marks.length) * 1e6) / 1e6);
  return shares;
}

function shapeKeys(base: string, shape: string, method: Method): string {
  if (method === 'telex') return shape === CIRCUMFLEX ? base : base === base.toLowerCase() ? 'w' : 'W';
  return shape === CIRCUMFLEX ? '6' : shape === BREVE ? '8' : '7';
}

function syllableKeys(syllable: string, method: Method): string {
  const letters = Array.from(syllable).map(letter);
  const typed = letters.map((l) => {
    if (l.dBar) return method === 'telex' ? (l.base === D_BAR ? 'dd' : 'DD') : (l.base === D_BAR ? 'd9' : 'D9');
    return l.base + (l.shape ? shapeKeys(l.base, l.shape, method) : '');
  });
  const toneMark = letters.find((l) => l.tone)?.tone;
  let tone = toneMark ? (method === 'telex' ? TELEX_TONE : VNI_TONE)[toneMark] : '';
  // the last letter of the first vowel run
  let runEnd = -1;
  for (let i = 0; i < letters.length; i++) {
    if (!letters[i].dBar && VOWELS.has(letters[i].base.toLowerCase())) runEnd = i;
    else if (runEnd >= 0) break;
  }
  let out = '';
  letters.forEach((_, i) => {
    out += typed[i];
    if (i === runEnd && tone) { out += tone; tone = ''; }
  });
  return out + tone;
}

/** The keys that type `text` with `method`, syllable by syllable. */
export function keystrokes(text: string, method: Method): string {
  return text.split(' ').map((s) => syllableKeys(s, method)).join(' ');
}
