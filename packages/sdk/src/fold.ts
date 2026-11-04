import { asMap, field, relationships, tags } from './fields';
import type { Repo } from './port';
import type { IndexedNote, Json } from './types';

/**
 * A note's own parts (its canvas, template, cards) used to be notes attached to it: a `canvas@1` that is `canvas-of`
 * it, a `template@1` that is `template-of` it, `flashcard@1` notes that are `card-of` it. Now they're keys on it.
 * There's no bulk migration. Readers take the host's key first, else the attached notes. Each save through the new
 * form writes the key and retires the attached notes (tag `retired`, `folded: {into, hash}`). If a retired note is
 * edited afterwards (another device, the YAML editor), `hash` no longer matches, and `staleFolds` offers it back.
 *
 * Pure: hashing is passed in (`cardId`, `contentHash` from the client in the app).
 */

export type Part = 'canvas' | 'template' | 'cards';
export type Hashing = { cardId: (front: string) => string; contentHash: (text: string) => string };

/** The relationship label from an attached note to its host. */
export const ATTACHED_LABEL: Record<Part, string> = { canvas: 'canvas-of', template: 'template-of', cards: 'card-of' };
/** The tag every attached note of that part has, to query for them. */
export const ATTACHED_TAG: Record<Part, string> = { canvas: 'canvas', template: 'template', cards: 'flashcard' };

export const RETIRED = 'retired';
export const ON_CANVAS = 'on-canvas';

export type Card = { id: string; front: string; back: string };
export type Template = { format: string; source: string; name?: string };
/** A part as read: from the host's key, from attached notes, or not there at all. */
export type Read<T> = { value: T | undefined; from: 'host' | 'attached' | 'none' };

type JsonMap = { [key: string]: Json };

const isRetired = (n: IndexedNote) => tags(n).includes(RETIRED);
const attachedTo = (n: IndexedNote, part: Part, hostId: string) =>
  tags(n).includes(ATTACHED_TAG[part]) && relationships(n).some((r) => r.label === ATTACHED_LABEL[part] && r.target === hostId);
const byKey = (a: IndexedNote, b: IndexedNote) => a.key.localeCompare(b.key);

/** The attached notes of `part` for the host that aren't retired yet, by key. */
export function attached(notes: IndexedNote[], hostId: string, part: Part): IndexedNote[] {
  return notes.filter((n) => !isRetired(n) && attachedTo(n, part, hostId)).sort(byKey);
}

/** The attached notes of `part` that were folded into the host. */
export function folded(notes: IndexedNote[], hostId: string, part: Part): IndexedNote[] {
  return notes.filter((n) => isRetired(n) && asMap(field(n, 'folded') ?? null)?.into === hostId && attachedTo(n, part, hostId)).sort(byKey);
}

/** Whether the host has the part as a key (any value, even a broken one). */
export const hasKey = (host: IndexedNote, part: Part) => field(host, part) !== undefined;

/** What of an attached note becomes the part: the canvas's nodes, the template, one card (without its id). */
function attachedPart(n: IndexedNote, part: Part): Json {
  const v = asMap(n.value) ?? {};
  switch (part) {
    case 'canvas': return v.nodes ?? null;
    case 'template': return { format: v.format ?? null, source: v.source ?? null, ...(typeof v.title === 'string' ? { name: v.title } : {}) };
    case 'cards': return { front: v.front ?? null, back: v.back ?? null };
  }
}

const hashOf = (n: IndexedNote, part: Part, h: Hashing) => h.contentHash(JSON.stringify(attachedPart(n, part)));

/** The canvas's stored nodes: the host's `canvas.nodes`, else the first attached canvas's `nodes`. Not checked. */
export function readCanvas(host: IndexedNote, attachedNotes: IndexedNote[]): Read<Json> {
  if (hasKey(host, 'canvas')) return { value: asMap(field(host, 'canvas') ?? null)?.nodes ?? null, from: 'host' };
  const first = attachedNotes[0];
  return first ? { value: field(first, 'nodes') ?? null, from: 'attached' } : { value: undefined, from: 'none' };
}

const text = (v: Json | undefined) => (typeof v === 'string' ? v : '');

function toTemplate(v: Json | undefined): Template | undefined {
  const m = asMap(v ?? null);
  if (!m) return undefined;
  return { format: text(m.format) || 'jinja-html', source: text(m.source), ...(typeof m.name === 'string' ? { name: m.name } : {}) };
}

/** The template: the host's `template`, else the first attached template note's. */
export function readTemplate(host: IndexedNote, attachedNotes: IndexedNote[]): Read<Template> {
  if (hasKey(host, 'template')) return { value: toTemplate(field(host, 'template')), from: 'host' };
  const first = attachedNotes[0];
  return first ? { value: toTemplate(attachedPart(first, 'template')), from: 'attached' } : { value: undefined, from: 'none' };
}

/**
 * The cards: the host's `cards`, else one per attached flashcard note. A card without an `id` gets the `cardId`
 * of its front, as cards from attached notes do; items that aren't maps are left out.
 */
export function readCards(host: IndexedNote, attachedNotes: IndexedNote[], h: Hashing): Read<Card[]> {
  const card = (v: Json | undefined): Card[] => {
    const m = asMap(v ?? null);
    if (!m) return [];
    const front = text(m.front);
    return [{ id: typeof m.id === 'string' && m.id ? m.id : h.cardId(front), front, back: text(m.back) }];
  };
  if (hasKey(host, 'cards')) {
    const v = field(host, 'cards');
    return { value: Array.isArray(v) ? v.flatMap(card) : [], from: 'host' };
  }
  if (!attachedNotes.length) return { value: undefined, from: 'none' };
  return { value: attachedNotes.flatMap((n) => card(attachedPart(n, 'cards'))), from: 'attached' };
}

/** Why a host can't take a part, if it can't: its YAML must parse to a map, or saving would replace its text. */
export function unwritable(host: IndexedNote): string | null {
  if (host.parse_error) return `the note's YAML doesn't parse (${host.parse_error.message})`;
  if (host.value !== null && !asMap(host.value)) return 'the note is not a YAML map';
  return null;
}

const refKey = (r: Json) => JSON.stringify(r);
function union(into: Json[], add: Json[]): Json[] {
  const out = [...into];
  const seen = new Set(into.map(refKey));
  for (const r of add) {
    if (seen.has(refKey(r))) continue;
    seen.add(refKey(r));
    out.push(r);
  }
  return out;
}
const list = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const label = (r: Json) => asMap(r)?.label;

/** The ids of the notes on a canvas, each once, in z-order. */
export function canvasLinks(nodes: Json | undefined): string[] {
  return [...new Set(list(nodes).flatMap((n) => { const note = asMap(n)?.note; return typeof note === 'string' ? [note] : []; }))];
}

export type FoldWrites = {
  /** the host's new value */
  host: JsonMap;
  /** attached notes to retire: key and new value */
  retire: { key: string; value: JsonMap }[];
};

/**
 * Saving `part` as `value` on the host: the host with the key set, plus the attached notes (not retired yet) to retire.
 * The canvas also sets the host's `on-canvas` relationships to the notes on it. Cards bring the relationships
 * (but `card-of`) and blobs of the card notes they fold. Write the host first: if the retiring doesn't happen, the
 * next save does it. Throws when the host can't be written (`unwritable`).
 */
export function foldWrites(host: IndexedNote, part: Part, value: Json, attachedNotes: IndexedNote[], h: Hashing): FoldWrites {
  const problem = unwritable(host);
  if (problem) throw new Error(`Can't save into this note: ${problem}`);
  const base: JsonMap = asMap(host.value) ?? { id: host.id };
  const next: JsonMap = { ...base, [part]: value };
  if (part === 'canvas') {
    const nodes = asMap(value)?.nodes;
    next.relationships = [
      ...list(base.relationships).filter((r) => label(r) !== ON_CANVAS),
      ...canvasLinks(nodes).map((to) => ({ to, label: ON_CANVAS })),
    ];
  }
  if (part === 'cards') {
    let rels = list(base.relationships);
    let blobs = list(base.blobs);
    for (const n of attachedNotes) {
      const v = asMap(n.value) ?? {};
      rels = union(rels, list(v.relationships).filter((r) => label(r) !== ATTACHED_LABEL.cards));
      blobs = union(blobs, list(v.blobs));
    }
    if (rels.length) next.relationships = rels;
    if (blobs.length) next.blobs = blobs;
  }
  for (const k of ['relationships', 'blobs'] as const) if (Array.isArray(next[k]) && !next[k].length && base[k] === undefined) delete next[k];
  const retire = attachedNotes.map((n) => ({ key: n.key, value: retiredValue(n, part, host.id, h) }));
  return { host: next, retire };
}

/** Writes a fold: the host first, then each note to retire. */
export async function writeFold(repo: Pick<Repo, 'putValue'>, hostKey: string, writes: FoldWrites): Promise<void> {
  await repo.putValue(hostKey, writes.host);
  for (const r of writes.retire) await repo.putValue(r.key, r.value);
}

function retiredValue(n: IndexedNote, part: Part, hostId: string, h: Hashing): JsonMap {
  const v: JsonMap = { ...(asMap(n.value) ?? { id: n.id }) };
  const t = list(v.tags);
  v.tags = t.includes(RETIRED) ? t : [...t, RETIRED];
  v.folded = {
    into: hostId,
    hash: hashOf(n, part, h),
    ...(part === 'cards' ? { card: h.cardId(text(asMap(n.value)?.front)) } : {}),
  };
  return v;
}

/** Folded notes edited since they were folded (their part no longer matches `folded.hash`). */
export function staleFolds(foldedNotes: IndexedNote[], part: Part, h: Hashing): IndexedNote[] {
  return foldedNotes.filter((n) => asMap(field(n, 'folded') ?? null)?.hash !== hashOf(n, part, h));
}

/** "Keep this one": the stale note's new value, its `folded.hash` matching what it holds now. */
export function acknowledge(n: IndexedNote, part: Part, h: Hashing): JsonMap {
  const v: JsonMap = { ...asMap(n.value) };
  v.folded = { ...asMap(v.folded ?? null), hash: hashOf(n, part, h) };
  return v;
}

/**
 * "Use that version": the part as it would be with the stale note's content taken over. The canvas and the
 * template are replaced; a card replaces the one it was folded as (`folded.card`), or is added if that's gone.
 * Save it with `foldWrites` (no attached notes left), then `acknowledge` the stale note.
 */
export function adopt(host: IndexedNote, n: IndexedNote, part: Part, h: Hashing): Json {
  const content = attachedPart(n, part);
  if (part === 'canvas') return { ...asMap(field(host, 'canvas') ?? null), nodes: content };
  if (part === 'template') return content;
  const id = text(asMap(field(n, 'folded') ?? null)?.card) || h.cardId(text(asMap(content)?.front));
  const cards = readCards(host, [], h).value ?? [];
  const card: Card = { id, front: text(asMap(content)?.front), back: text(asMap(content)?.back) };
  const at = cards.findIndex((c) => c.id === id);
  return at < 0 ? [...cards, card] : cards.map((c, i) => (i === at ? card : c));
}
