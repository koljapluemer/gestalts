import { asMap } from './fields';
import type { Json } from './types';

/**
 * A note's prose links as data: each `[[target]]` in `main`, `extra` or a card is an `inline`-labelled relationship,
 * and each `![[blob]]` is listed in `blobs`. Keeping them there lets everything that follows relationships (the
 * copy-on-write closure, backlinks, the graph) see prose links without parsing Markdown.
 *
 * Pure: the Markdown parser is passed in (`references` from the UI's primitives in the app).
 */

type JsonMap = { [key: string]: Json };

export const INLINE = 'inline';

/** The references of a Markdown text, outside code and math. */
export type RefsOf = (markdown: string) => { target: string; embed: boolean }[];

const list = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const text = (v: Json | undefined) => (typeof v === 'string' ? v : '');

/** The Markdown texts of a note whose references count: `main`, `extra`, each card's front and back. */
export function inlineTexts(value: Json | null | undefined): string[] {
  const v = asMap(value);
  if (!v) return [];
  const cards = list(v.cards).flatMap((c) => { const m = asMap(c); return m ? [text(m.front), text(m.back)] : []; });
  return [text(v.main), text(v.extra), ...cards].filter((t) => t.includes('[['));
}

/** The note's `[[targets]]` and `![[embeds]]`, each once, in order of first appearance. */
export function inlineRefs(value: Json | null | undefined, refsOf: RefsOf): { targets: string[]; embeds: string[] } {
  const targets = new Set<string>();
  const embeds = new Set<string>();
  for (const t of inlineTexts(value)) for (const r of refsOf(t)) (r.embed ? embeds : targets).add(r.target);
  return { targets: [...targets], embeds: [...embeds] };
}

const relTarget = (r: Json) => (typeof r === 'string' ? r : text(asMap(r)?.to));
const relLabel = (r: Json) => (typeof r === 'string' ? null : (asMap(r)?.label ?? null));
const blobFile = (b: Json) => (typeof b === 'string' ? b : text(asMap(b)?.file));

/**
 * The note with its `inline` relationships matching its references (kept in place, gone ones dropped, new ones
 * appended) and every embedded blob listed in `blobs`. Other relationships stay as they are; blobs are never
 * dropped here. A reference to the note itself is no relationship.
 */
export function syncInline(value: Json | null | undefined, refsOf: RefsOf): JsonMap {
  const v: JsonMap = { ...asMap(value) };
  const { targets, embeds } = inlineRefs(v, refsOf);
  const self = typeof v.id === 'string' ? v.id : null;
  const wanted = new Set(targets.filter((t) => t !== self));

  const had = list(v.relationships);
  const seen = new Set<string>();
  const rels = had.filter((r) => {
    if (relLabel(r) !== INLINE) return true;
    const t = relTarget(r);
    if (!wanted.has(t) || seen.has(t)) return false;
    seen.add(t);
    return true;
  });
  for (const t of wanted) if (!seen.has(t)) rels.push({ to: t, label: INLINE });
  if (rels.length) v.relationships = rels;
  else if (v.relationships !== undefined && had.length) delete v.relationships;

  const blobs = list(v.blobs);
  const files = new Set(blobs.map(blobFile));
  const added = embeds.filter((e) => !files.has(e));
  if (added.length) v.blobs = [...blobs, ...added];
  return v;
}

/** Whether `syncInline` would change the note. */
export function inlineOutOfSync(value: Json | null | undefined, refsOf: RefsOf): boolean {
  const v = asMap(value);
  if (!v) return false;
  return JSON.stringify(syncInline(v, refsOf)) !== JSON.stringify(v);
}
