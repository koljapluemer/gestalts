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
  /** ymls that reference `to`, through the prop `field` if given */
  refs?: { to: string; field?: string };
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

export type Page = { items: Item[]; next: string | null };

/** What changed in one live query's page. */
export type Delta = { sub: number; upsert: Item[]; remove: string[]; order: string[]; next: string | null };

export type Problem = { path: string; message: string };
/** A yml that can't be used, and why. */
export type Health = { id: string; problems: Problem[] };
