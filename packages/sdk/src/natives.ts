import type { Json } from './types';

/**
 * What the host computes in its core (ids, hashes, BibTeX), provided once at startup with `provideNatives`. The SDK
 * itself has no core, so it can run anywhere the host can reach (later: inside a sandboxed frame).
 */
export type Natives = {
  newId(): string;
  stableId(namespace: string, name: string): string;
  stateKey(gestalt: string, target: string, facet?: string): string;
  cardId(front: string): string;
  contentHash(text: string): string;
  bib: {
    parse(text: string): unknown;
    write(sources: Source[]): string;
    matches(entry: Source, existing: { key: string; source: Source }[], limit: number): unknown;
    merge(current: Source, incoming: Source, take: string[]): unknown;
    uniqueCitekey(key: string, taken: string[]): string;
    citedKeys(typst: string): string[];
    model(): unknown;
  };
};

let natives: Natives | null = null;

/** Called by the host before rendering anything. */
export function provideNatives(n: Natives) {
  natives = n;
}

function n(): Natives {
  if (!natives) throw new Error('@gestalts/sdk: the host has not provided its natives yet');
  return natives;
}

/** A fresh random uuid. */
export const newId = () => n().newId();
/** The same id for the same `name` within `namespace` (uuid5), e.g. one daily note per date. */
export const stableId = (namespace: string, name: string) => n().stableId(namespace, name);
/**
 * The key of a learner-state note (`fsrs-state`, `practice-state`) for the note `target`, or one `facet` of it,
 * so two devices rating the same card write one note.
 */
export const stateKey = (gestalt: string, target: string, facet?: string) => n().stateKey(gestalt, target, facet);
/** What identifies a card within its note: dsl's `card_id`, 12 hex digits of the sha1 of its trimmed front. */
export const cardId = (front: string) => n().cardId(front);
/** Hex sha256 of a text. */
export const contentHash = (text: string) => n().contentHash(text);
/** The hashing `fold` needs. */
export const hashing = { cardId: (front: string) => cardId(front), contentHash: (text: string) => contentHash(text) };

/** A source as a note's map: `title`, `citekey`, `entrytype`, biblatex fields, `bib_extra`. */
export type Source = { [field: string]: Json };
export type FieldKind = 'names' | 'list' | 'date' | 'verbatim' | 'literal';
export type SourceMatch = { key: string; level: 'same' | 'likely' | 'possible'; reasons: string[] };
export type SourceMerge = { source: Source; filled: string[]; conflicts: { field: string; current: Json; incoming: Json }[] };

/** Bibliographic sources (`source@1`) and BibTeX, from the host's core. */
export const bib = {
  /** The entries of BibTeX text; throws when there are none. */
  parse: (text: string) => n().bib.parse(text) as { source: Source; warnings: string[] }[],
  /** Sources as biblatex text, by citekey. */
  write: (sources: Source[]) => n().bib.write(sources),
  /** The existing sources that may be `entry`, best first. */
  matches: (entry: Source, existing: { key: string; source: Source }[], limit = 3) => n().bib.matches(entry, existing, limit) as SourceMatch[],
  /** `current` updated from `incoming`; fields named in `take` are replaced, other differences are conflicts. */
  merge: (current: Source, incoming: Source, take: string[] = []) => n().bib.merge(current, incoming, take) as SourceMerge,
  uniqueCitekey: (key: string, taken: string[]) => n().bib.uniqueCitekey(key, taken),
  /** The keys a Typst document cites, in order. */
  citedKeys: (typst: string) => n().bib.citedKeys(typst),
  model: () => n().bib.model() as { entryTypes: [string, string[]][]; fields: [string, FieldKind][] },
};
