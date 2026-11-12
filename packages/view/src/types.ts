/** The shapes that cross between the core, the host and a view. */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonMap = { [key: string]: Json };

/** A yml, as views get it. `value` holds `id` and `gestalt` too. */
export type Item = { id: string; gestalt: string; value: JsonMap };

/** How a query's items are sorted; by id when not given. */
export type Order = { field: string; desc?: boolean } | { seed: number };

/** Which ymls a view wants. All given conditions must hold. */
export type Query = {
  /** `name@version`; a view must say which gestalt it asks for */
  gestalt?: string;
  ids?: string[];
  /** exact matches on top-level props */
  where?: Record<string, Json>;
  tags?: { all?: string[]; none?: string[] };
  /** ymls that reference `to`, through the prop `field` and with the `label` (of a `relationships` item) if given */
  refs?: { to: string; field?: string; label?: string };
  /** what the yml itself references: each of `all` by some reference, none of `none` by any */
  links?: { all?: LinkMatch[]; none?: LinkMatch[] };
  /** every word must start a word of the yml's text; case and diacritics don't matter */
  text?: string;
  order?: Order;
  /** 100 when not given, 500 at most */
  limit?: number;
  /** the `next` of the page before */
  cursor?: string;
  /** only these props (with `id` and `gestalt`, always) */
  fields?: string[];
};

/** What a yml a link points at must be; a target that isn't there is no shape. */
export type Shape = { gestalt?: string; ids?: string[]; where?: Record<string, Json>; tags?: { all?: string[]; none?: string[] } };

/** One kind of reference: through `field`, labelled `label`, to a yml of shape `to`, each if given. */
export type LinkMatch = { field?: string; label?: string; to?: Shape };

export type Page = { items: Item[]; next: string | null };

/**
 * An outline over labelled references, worked out by the app (Luhmann's Zettelkasten is one): a yml `follows` another
 * (next after it) or `branches` from it (starts a sequence under it); the yml tagged `rootTag` starts it all;
 * `excludeTag` keeps one out without placing it.
 */
export type OutlineSpec = { gestalt: string; field: string; follows: string; branches: string; rootTag: string; excludeTag: string };

/**
 * The rows under a yml (the top level for `null`), a yml and what follows it as rows (what hangs on a floating one),
 * where some ymls are, or everything that doesn't add up.
 */
export type OutlineAsk = { children: string | null } | { sequence: string } | { locate: string[] } | 'loose';

/** `subject` (for `locate`): also say of each yml whether it is placed below that one, so placing it there makes a cycle. */
export type OutlineQuery = { spec: OutlineSpec; ask: OutlineAsk; limit?: number; cursor?: string; fields?: string[]; subject?: string };

export type OutlineStatus = 'root' | 'attached' | 'floating' | 'unplaced' | 'excluded';

/**
 * Something that doesn't add up. The first of a floating chain says why (`parentMissing`, `parentUnplaced`,
 * `parentExcluded`, or `cycle` on the lowest id of one); `fork`: not the first to follow or branch from `target`.
 */
export type OutlineMark = {
  kind: 'parentMissing' | 'parentUnplaced' | 'parentExcluded' | 'cycle' | 'placedTwice' | 'fork' | 'extraRoot' | 'rootPlaced' | 'excludedPlaced';
  target?: string;
};

/**
 * A yml in an outline. For `locate`: `path`, the ymls it's shown under, from the top level down, and with a `subject`,
 * `belowSubject`.
 */
export type OutlineEntry = { item: Item; status: OutlineStatus; hasChildren: boolean; marks: OutlineMark[]; path?: Item[]; belowSubject?: boolean };

export type OutlinePage = { entries: OutlineEntry[]; next: string | null };

/** An outline subscription's page again, whole, after something it shows changed. */
export type OutlineDelta = { sub: number; page: OutlinePage };

/** What changed in one live query's page. */
export type Delta = { sub: number; upsert: Item[]; remove: string[]; order: string[]; next: string | null };

/**
 * What is believed about how well the learner knows a concept, worked out by the app from all practice: `mean` on the
 * logit scale (0 is a coin flip), `sd` how unsure that is, `p` the chance of getting something on it right, `evidence`
 * how many events were on it directly, `lastAt` the last one that reached it.
 */
export type Belief = { concept: string; mean: number; sd: number; p: number; evidence: number; lastAt?: string };

/** What changed about one belief subscription's concepts. */
export type BeliefDelta = { sub: number; beliefs: Belief[] };

export type Problem = { path: string; message: string };
/** A yml that can't be used, and why. */
export type Health = { id: string; problems: Problem[] };
