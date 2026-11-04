import { useMemo } from 'react';
import { useRepo, useRepoVersion, type RefsOf, type Repo } from '@gestalts/sdk';
import { references } from '../primitives';
import { buildBacklinks, type Backlink } from './relationModel';

const parsed = new Map<string, { target: string; embed: boolean }[]>();

/**
 * The references of a Markdown text, cached by the text: rebuilding the backlinks after each change reparses only
 * the texts that changed.
 */
export const refsOf: RefsOf = (text) => {
  let refs = parsed.get(text);
  if (!refs) {
    if (parsed.size > 50_000) parsed.clear();
    refs = references(text).map((r) => ({ target: r.target, embed: r.embed }));
    parsed.set(text, refs);
  }
  return refs;
};

let cache: { repo: Repo; version: number; index: Map<string, Backlink[]> } | null = null;

/** Every note's backlinks, built once per repo version and shared by every widget showing them. */
function backlinkIndex(repo: Repo): Map<string, Backlink[]> {
  if (cache?.repo !== repo || cache.version !== repo.version) {
    cache = { repo, version: repo.version, index: buildBacklinks(repo.query({}), (id) => repo.keyOf(id), refsOf) };
  }
  return cache.index;
}

/** The links from other notes to the note `key`: explicit relationships and inline references. */
export function useBacklinks(key: string): Backlink[] {
  const repo = useRepo();
  const version = useRepoVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` stands for the repo's content
  return useMemo(() => backlinkIndex(repo).get(key) ?? [], [repo, key, version]);
}
