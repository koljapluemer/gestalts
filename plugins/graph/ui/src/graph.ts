import { INLINE, asMap, inlineRefs, relationships, type IndexedNote, type Json, type Query, type RefsOf } from '@gestalts/sdk';

/**
 * The graph, from the notes alone: the notes in its scope, the relationships between them, and the part of it the
 * pins show. Pure, so it can be tested without a repo; the pane builds it from `repo.query(SCOPE)`.
 */

/** The tag the hide button puts on a note to leave it out of the graph. */
export const HIDE_TAG = 'no-graph';

/**
 * The notes the graph shows: yours. As dsl's graph it leaves out appointments, recurring items, sources, dailies and
 * explorations; then bookkeeping (learner state, sessions, settings, installs, conflicts) and deck content, whose
 * relationships (a country's distractors) would crowd out your own. Notes whose YAML doesn't parse are left out too.
 */
export const SCOPE: Query = {
  gestaltsNone: [
    'appointment@1', 'recurring@1', 'source@1', 'daily@1',
    'fsrs-state@1', 'practice-state@1', 'practice-session@1', 'settings@1', 'plugin-install@1', 'conflict@1',
    'country@1', 'term@1', 'sentence@1', 'scene-object@1', 'interaction@1', 'flashcard@1', 'pronunciation-card@1', 'quote@1',
  ],
  tagsNone: [HIDE_TAG, 'exploration', 'retired'],
};

/** Relations shown from a pinned note, and from a note further out; the rest are counted as truncated. */
export const MAX_DIRECT_RELATIONS = 28;
export const MAX_SECONDARY_RELATIONS = 12;
/** Notes shown at most; the farthest from every pin are left out first. */
export const MAX_GRAPH_NODES = 140;

/** What an unlabelled relationship is called on its edge. */
export const UNLABELLED = 'related';

export type Pin = { key: string; depth: number };

/** A relationship of `source` to `target`; explicit (in `relationships`) or inline (a `[[reference]]` in the text). */
export type Relation = {
  source: string;
  target: string;
  /** null: unlabelled; always null for an inline one */
  label: string | null;
  inline: boolean;
  /** how the source names the target (its id, or key): what removing or relabelling it matches */
  via: string;
};

export type GraphEdge = Relation & {
  id: string;
  /** hops from the nearer end's pin to the farther end */
  depth: number;
};

export type GraphNode = {
  key: string;
  /** hops from the nearest pin */
  depth: number;
  /** relationships in and out */
  degree: number;
  /** related notes not on the canvas: what pinning it at depth 1 would bring in */
  hiddenNeighbors: number;
};

export type NoteGraph = { nodes: GraphNode[]; edges: GraphEdge[]; warnings: string[] };

export const EMPTY_GRAPH: NoteGraph = { nodes: [], edges: [], warnings: [] };

const byLabel = (a: Relation, b: Relation, other: (r: Relation) => string) =>
  Number(a.inline) - Number(b.inline) || (a.label ?? UNLABELLED).toLowerCase().localeCompare((b.label ?? UNLABELLED).toLowerCase())
  || other(a).localeCompare(other(b));

/** The notes in the graph and the relationships between them. */
export class GraphView {
  readonly notes: Map<string, IndexedNote>;
  private readonly out = new Map<string, Relation[]>();
  private readonly in = new Map<string, Relation[]>();

  /** `notes`: the notes in scope; `keyOf` resolves a relationship's target (an id or key) to a key. */
  constructor(notes: IndexedNote[], keyOf: (id: string) => string | undefined, refsOf: RefsOf) {
    this.notes = new Map(notes.filter((n) => !n.parse_error && asMap(n.value)).map((n) => [n.key, n]));
    for (const n of this.notes.values()) {
      const rels = relationsOf(n, keyOf, refsOf).filter((r) => this.notes.has(r.target));
      this.out.set(n.key, rels.sort((a, b) => byLabel(a, b, (r) => r.target)));
      for (const r of rels) {
        const list = this.in.get(r.target);
        if (list) list.push(r);
        else this.in.set(r.target, [r]);
      }
    }
    for (const list of this.in.values()) list.sort((a, b) => byLabel(a, b, (r) => r.source));
  }

  outgoing(key: string): Relation[] { return this.out.get(key) ?? []; }

  incoming(key: string): Relation[] { return this.in.get(key) ?? []; }

  degree(key: string): number { return this.outgoing(key).length + this.incoming(key).length; }

  neighbors(key: string): Set<string> {
    return new Set([...this.outgoing(key).map((r) => r.target), ...this.incoming(key).map((r) => r.source)]);
  }
}

/**
 * A note's relationships, resolved to keys: each explicit one (`label`, target) once, then each inline reference
 * once, unless an explicit relationship to the same note already shows it. A note's links to itself don't count.
 */
export function relationsOf(n: IndexedNote, keyOf: (id: string) => string | undefined, refsOf: RefsOf): Relation[] {
  const explicit: Relation[] = [];
  const inline: Relation[] = [];
  const seen = new Set<string>();
  const add = (via: string, label: string | null, isInline: boolean) => {
    const target = keyOf(via);
    if (!target || target === n.key) return;
    const id = isInline ? `${target}\ninline` : `${target}\n${label ?? ''}`;
    if (seen.has(id)) return;
    seen.add(id);
    (isInline ? inline : explicit).push({ source: n.key, target, label: isInline ? null : label, inline: isInline, via });
  };
  for (const r of relationships(n)) add(r.target, r.label, r.label === INLINE);
  for (const t of inlineRefs(n.value, refsOf).targets) add(t, null, true);
  const explicitTargets = new Set(explicit.map((r) => r.target));
  return [...explicit, ...inline.filter((r) => !explicitTargets.has(r.target))];
}

export const edgeId = (r: Relation) => `${r.source}->${r.target}:${r.inline ? '\u0000inline' : (r.label ?? '')}`;

type Build = {
  /** key -> [depth, order] */
  nodes: Map<string, [number, number]>;
  edges: Map<string, GraphEdge>;
  queue: [string, number, number][];
  skippedRelations: number;
  skippedNodes: number;
};

/**
 * Every pin with the notes within its depth: a breadth-first search from all pins at once, so when MAX_GRAPH_NODES
 * is hit the notes left out are the farthest from every pin.
 */
export function buildGraph(view: GraphView, pins: readonly Pin[]): NoteGraph {
  const b: Build = { nodes: new Map(), edges: new Map(), queue: [], skippedRelations: 0, skippedNodes: 0 };
  for (const pin of pins) {
    if (!view.notes.has(pin.key)) continue;
    const existing = b.nodes.get(pin.key);
    b.nodes.set(pin.key, [0, existing ? existing[1] : b.nodes.size]);
    if (pin.depth > 0) expand(view, b, pin.key, 0, pin.depth);
  }
  for (let next = b.queue.shift(); next; next = b.queue.shift()) expand(view, b, ...next);
  return finish(view, b);
}

function expand(view: GraphView, b: Build, key: string, depth: number, maxDepth: number): void {
  const limit = depth === 0 ? MAX_DIRECT_RELATIONS : MAX_SECONDARY_RELATIONS;
  for (const [relations, far] of [[view.outgoing(key), (r: Relation) => r.target], [view.incoming(key), (r: Relation) => r.source]] as const) {
    b.skippedRelations += Math.max(0, relations.length - limit);
    for (const r of relations.slice(0, limit)) {
      const id = edgeId(r);
      if (!b.edges.has(id)) b.edges.set(id, { ...r, id, depth: depth + 1 });
      // a note at the depth budget is still expanded, for its edges to notes already shown
      if (depth + 1 <= maxDepth && register(b, far(r), depth + 1)) b.queue.push([far(r), depth + 1, maxDepth]);
    }
  }
}

/** Whether `key` is new to the graph. */
function register(b: Build, key: string, depth: number): boolean {
  const existing = b.nodes.get(key);
  if (existing) {
    existing[0] = Math.min(existing[0], depth);
    return false;
  }
  if (b.nodes.size >= MAX_GRAPH_NODES) {
    b.skippedNodes += 1;
    return false;
  }
  b.nodes.set(key, [depth, b.nodes.size]);
  return true;
}

function finish(view: GraphView, b: Build): NoteGraph {
  const warnings: string[] = [];
  if (b.skippedRelations) warnings.push(`Left out ${b.skippedRelations} relationships to keep the graph responsive.`);
  if (b.skippedNodes) warnings.push(`Left out ${b.skippedNodes} more notes: the graph shows at most ${MAX_GRAPH_NODES}.`);
  const nodes = [...b.nodes].map(([key, [depth]]): GraphNode => ({
    key,
    depth,
    degree: view.degree(key),
    hiddenNeighbors: [...view.neighbors(key)].filter((n) => !b.nodes.has(n)).length,
  }));
  nodes.sort((x, y) => x.depth - y.depth || y.degree - x.degree || x.key.localeCompare(y.key));
  return {
    nodes,
    // an edge can lead to a note past its pin's depth, or one cut by the size cap
    edges: [...b.edges.values()].filter((e) => b.nodes.has(e.source) && b.nodes.has(e.target)),
    warnings,
  };
}

/** Any note in the graph not in `exclude`, or only one without relationships; null when there's none. */
export function randomKey(view: GraphView, exclude: Iterable<string>, orphan: boolean, random: () => number = Math.random): string | null {
  const excluded = new Set(exclude);
  const pool = [...view.notes.keys()].filter((k) => !excluded.has(k) && (!orphan || view.degree(k) === 0));
  return pool.length ? pool[Math.floor(random() * pool.length)] : null;
}

/** The pins stored in the graph's settings, the malformed ones left out. */
export function readPins(raw: Json | undefined): Pin[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p): Pin[] => {
    const m = asMap(p);
    const key = m?.key;
    const depth = m?.depth;
    return typeof key === 'string' && key.trim() && typeof depth === 'number' && Number.isInteger(depth) && depth >= 0 ? [{ key, depth }] : [];
  });
}
