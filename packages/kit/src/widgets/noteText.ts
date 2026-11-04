import { useMemo } from 'react';
import { asMap, inlineOutOfSync, noteLabel, syncInline, useQuery, useRepo, type Json, type Repo } from '@gestalts/sdk';
import type { ReferenceCandidate } from '../primitives';
import { refsOf } from './backlinks';
import { buildIndex, search } from './noteSearch';

type JsonMap = { [key: string]: Json };

/** The fields the Text mode edits. */
export const TEXT_FIELDS = ['title', 'main', 'extra'] as const;
export type TextFields = Record<(typeof TEXT_FIELDS)[number], string>;

export function textFields(value: Json | null | undefined): TextFields {
  const v = asMap(value);
  const s = (k: string) => (typeof v?.[k] === 'string' ? (v[k] as string) : '');
  return { title: s('title'), main: s('main'), extra: s('extra') };
}

/** Why a note can't be edited as text, or null. */
export function textUneditable(value: Json | null | undefined): string | null {
  const v = asMap(value);
  if (!v) return 'its YAML doesn\'t parse (or isn\'t a map)';
  const bad = TEXT_FIELDS.filter((k) => v[k] !== undefined && v[k] !== null && typeof v[k] !== 'string');
  return bad.length ? `${bad.join(', ')} ${bad.length > 1 ? 'aren\'t' : 'isn\'t'} text` : null;
}

/**
 * A text draft saved onto the note as it is now: the fields the draft changed (against `base`, the fields when the
 * draft started) are set, an empty one removed, the rest of the note kept. When the note changed one of those fields
 * meanwhile to something else, nothing is written over it, unless `force`. Inline references are synced.
 */
export function applyTextDraft(current: JsonMap, base: TextFields, draft: TextFields, force = false): { kind: 'write'; value: JsonMap } | { kind: 'conflict' } {
  const now = textFields(current);
  const next: JsonMap = { ...current };
  for (const k of TEXT_FIELDS) {
    const d = k === 'title' ? draft[k].replace(/\s*\n\s*/g, ' ').trim() : draft[k];
    if (d === base[k] || d === now[k]) continue;
    if (!force && now[k] !== base[k]) return { kind: 'conflict' };
    if (d.trim()) next[k] = d;
    else delete next[k];
  }
  return { kind: 'write', value: syncInline(next, refsOf) };
}

/** Writes raw YAML; if its inline relationships or embedded blobs are out of date, the note with them brought up to date. */
export async function saveRawSynced(repo: Repo, key: string, raw: string): Promise<unknown> {
  const n = repo.inspect(key, raw);
  if (!n.parse_error && inlineOutOfSync(n.value, refsOf)) return repo.putValue(key, syncInline(n.value, refsOf));
  return repo.putRaw(key, raw);
}

/** `value` with its inline relationships and embedded blobs brought up to date. */
export const withInline = (value: Json | null | undefined) => syncInline(value, refsOf);

const LIMIT = 8;

/** What a Markdown field needs for references: the notes to offer after `[[` (but `self`), and their labels. */
export function useReferenceTools(self?: string) {
  const repo = useRepo();
  const notes = useQuery({ tagsNone: ['retired'] });
  const index = useMemo(() => buildIndex(notes), [notes]);
  return useMemo(() => ({
    search: (q: string): ReferenceCandidate[] => search(index, q).notes
      .filter((n) => n.key !== self)
      .slice(0, LIMIT)
      .map((n) => ({ target: n.id, label: noteLabel(n), detail: n.gestalts[0] })),
    labelOf: (target: string): string | null => {
      const key = repo.keyOf(target);
      const n = key ? repo.get(key) : undefined;
      return n ? noteLabel(n) : null;
    },
  }), [index, self, repo]);
}
