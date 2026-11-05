import ELK, { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { XYPosition } from '@xyflow/react';
import { UNLABELLED, type NoteGraph } from './graph';

/**
 * The pure ELK layer: given a graph, every note's measured height and the
 * user-dragged positions, it returns a slot (centre position + size) per note.
 * No React, no side effects beyond the shared ELK worker instance - the layout
 * lifecycle (when to lay out, anchoring, drops) lives in `useElkLayout`.
 */

export const NODE_WIDTH = 370;

// A hidden-relations badge (see hiddenRelations.ts) hangs below its card:
// `HIDDEN_BADGE_GAP` clear of the card's bottom edge, then `HIDDEN_BADGE_HEIGHT`
// tall (daisy `btn-xs`). It lives outside ELK, so the gap between vertically
// stacked cards is widened to leave that footprint free plus the usual clearance.
export const HIDDEN_BADGE_GAP = 24;
const HIDDEN_BADGE_HEIGHT = 24;
const NODE_GAP = HIDDEN_BADGE_GAP + HIDDEN_BADGE_HEIGHT + 56;
const LAYER_GAP = 200;

// Fixed footprint reserved for every edge's label, so ELK's layered algorithm
// widens the gap between layers rather than letting a label print on top of the
// next note card. Deduced from the collapsed label pill's classes in
// FloatingEdge.tsx (`text-xs font-bold px-2 py-0.5 border`), not measured from
// the real DOM - see estimateEdgeLabelSize below for why a fixed guess is used
// here instead of the measure-then-layout approach used for card heights.
const EDGE_LABEL_FONT_SIZE = 12; // text-xs
const EDGE_LABEL_LINE_HEIGHT = 16; // text-xs line-height
const EDGE_LABEL_AVG_CHAR_WIDTH = EDGE_LABEL_FONT_SIZE * 0.6; // rough glyph width, bold sans-serif
const EDGE_LABEL_ESTIMATED_CHARS = 20; // typical relation label length; longer ones just overflow the reserved box
const EDGE_LABEL_HORIZONTAL_PADDING = 16; // px-2 on both sides
const EDGE_LABEL_VERTICAL_PADDING = 4; // py-0.5 on both sides
const EDGE_LABEL_BORDER = 2; // 1px border on both sides

function estimateEdgeLabelSize(): { width: number; height: number } {
  return {
    width: Math.round(EDGE_LABEL_ESTIMATED_CHARS * EDGE_LABEL_AVG_CHAR_WIDTH + EDGE_LABEL_HORIZONTAL_PADDING + EDGE_LABEL_BORDER),
    height: EDGE_LABEL_LINE_HEIGHT + EDGE_LABEL_VERTICAL_PADDING + EDGE_LABEL_BORDER,
  };
}

const ELK_LAYOUT_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'SPLINES',
  // Interactive mode + seeding each node's previous position (see computeLayout)
  // biases crossing-minimization and placement toward the existing layout instead
  // of solving fresh each time, so unrelated nodes mostly stay put when the graph
  // changes.
  'elk.interactive': 'true',
  'elk.layered.crossingMinimization.strategy': 'INTERACTIVE',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
  'elk.spacing.nodeNode': `${NODE_GAP}`,
  'elk.layered.spacing.nodeNodeBetweenLayers': `${LAYER_GAP}`,
  // ELK's own default, set explicitly since it's what makes the `labels` entry
  // below (see computeLayout) turn into a space-reserving dummy node between
  // layers instead of being ignored.
  'elk.edgeLabels.placement': 'CENTER',
} as const;

const elk = new ELK();

/** Where a note sits (its centre) and the box ELK reserved for it. */
export interface NodeSlot {
  position: XYPosition;
  width: number;
  height: number;
}

export interface GraphLayout {
  /** Every placed note's slot, by key. A note without one is not laid out yet. */
  slots: ReadonlyMap<string, NodeSlot>;
  /** `layoutStructureKey` of the graph these slots were computed for. */
  structure: string;
}

/**
 * Identity of everything about a graph's shape that ELK consumes: the note set
 * and which notes are linked. Label text is not part of it - every edge label
 * reserves the same fixed footprint (see estimateEdgeLabelSize).
 */
export function layoutStructureKey(graph: Pick<NoteGraph, 'nodes' | 'edges'>): string {
  const keys = graph.nodes.map((note) => note.key).sort();
  const links = graph.edges.map((edge) => JSON.stringify([edge.source, edge.target])).sort();
  return JSON.stringify([keys, links]);
}

export const EMPTY_LAYOUT: GraphLayout = {
  slots: new Map(),
  structure: layoutStructureKey({ nodes: [], edges: [] }),
};

// Height delta (px) below which a measured card isn't worth re-laying-out for -
// pairs with the quantum in collectMeasuredHeights.
const LAYOUT_HEIGHT_TOLERANCE = 8;

/** Minimal shape shared by React Flow's public `Node` and its `InternalNode`. */
export type MeasuredNode = { id: string; type?: string; measured?: { height?: number } };

// Quantum (px) the measured heights are snapped to. Coarse enough that sub-pixel
// render jitter can't register as a height change and retrigger the layout.
const MEASURED_HEIGHT_QUANTUM = 2;

/**
 * Per-`note`-node measured heights, keyed by id (the note's key).
 */
export function collectMeasuredHeights(nodes: Iterable<MeasuredNode>): Map<string, number> {
  const heights = new Map<string, number>();
  for (const node of nodes) {
    if (node.type === 'note' && node.measured?.height) {
      heights.set(node.id, Math.round(node.measured.height / MEASURED_HEIGHT_QUANTUM) * MEASURED_HEIGHT_QUANTUM);
    }
  }
  return heights;
}

/**
 * The height to lay out every graph note with: its measured height, else the
 * height its current slot was laid out with (a card whose live height is being
 * ignored, e.g. while it is edited). Null while any note has neither - a new
 * card React Flow has not measured yet.
 */
export function resolveLayoutHeights(
  graph: NoteGraph,
  measuredHeights: ReadonlyMap<string, number>,
  layout: GraphLayout,
): Map<string, number> | null {
  const heights = new Map<string, number>();
  for (const note of graph.nodes) {
    const height = measuredHeights.get(note.key) ?? layout.slots.get(note.key)?.height;
    if (height === undefined) {
      return null;
    }
    heights.set(note.key, height);
  }
  return heights;
}

/** Whether `layout` already accounts for this graph structure and these heights. */
export function isLayoutCurrent(layout: GraphLayout, structure: string, heights: ReadonlyMap<string, number>): boolean {
  if (layout.structure !== structure) {
    return false;
  }
  for (const [key, height] of heights) {
    const slot = layout.slots.get(key);
    if (!slot || Math.abs(slot.height - height) > LAYOUT_HEIGHT_TOLERANCE) {
      return false;
    }
  }
  return true;
}

/** Whether both layouts place the same notes at the same positions. */
export function samePositions(a: GraphLayout, b: GraphLayout): boolean {
  if (a.slots.size !== b.slots.size) {
    return false;
  }
  for (const [key, slot] of a.slots) {
    const other = b.slots.get(key);
    if (!other || other.position.x !== slot.position.x || other.position.y !== slot.position.y) {
      return false;
    }
  }
  return true;
}

/**
 * Where a note with no slot of its own starts out: next to the anchor (the note
 * last acted on). Without this, a note pinned with no relation to anything on
 * screen is laid out from scratch - it can land anywhere in the coordinate space,
 * and fitView then has to zoom out to fit both, sometimes far enough that neither
 * ends up actually on screen. Offset rather than the anchor's exact coordinate,
 * so a fresh node isn't asked to sit directly on top of its anchor.
 */
export function seedPosition(layout: GraphLayout, anchorKey: string | null): XYPosition | undefined {
  const anchor = anchorKey ? layout.slots.get(anchorKey) : undefined;
  return anchor ? { x: anchor.position.x + NODE_WIDTH + LAYER_GAP, y: anchor.position.y } : undefined;
}

// Clearance (px) forced between two card rectangles by separateOverlaps. Just
// under ELK's own `elk.spacing.nodeNode`, so post-ELK separation and ELK's spacing
// agree on what "not overlapping" means.
const SEPARATION_MARGIN = NODE_GAP - 8;
// Safety cap - card-sized boxes with local pushes settle well inside this.
const SEPARATION_ITERATIONS = 60;

/**
 * Nudges overlapping cards apart along their axis of least penetration, leaving
 * `pinned` nodes fixed (movable neighbours yield to them). ELK's `layered` won't
 * honour a dragged node's coordinate, so we pin it here and let this open space
 * around it; it also cleans up the residual overlaps ELK leaves around a
 * disconnected cluster seeded onto existing content.
 *
 * Pure: returns the same map when nothing overlaps.
 */
export function separateOverlaps(
  slots: ReadonlyMap<string, NodeSlot>,
  pinned: ReadonlySet<string>,
  margin = SEPARATION_MARGIN,
): ReadonlyMap<string, NodeSlot> {
  if (slots.size < 2) {
    return slots;
  }

  const entries = [...slots];
  const pos = entries.map(([, slot]) => ({ x: slot.position.x, y: slot.position.y }));
  const halfW = entries.map(([, slot]) => slot.width / 2 + margin / 2);
  const halfH = entries.map(([, slot]) => slot.height / 2 + margin / 2);
  const fixed = entries.map(([key]) => pinned.has(key));
  let moved = false;

  for (let iteration = 0; iteration < SEPARATION_ITERATIONS; iteration += 1) {
    let anyOverlap = false;

    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const dx = pos[j].x - pos[i].x;
        const dy = pos[j].y - pos[i].y;
        const penX = halfW[i] + halfW[j] - Math.abs(dx);
        const penY = halfH[i] + halfH[j] - Math.abs(dy);
        if (penX <= 0 || penY <= 0) {
          continue;
        }
        if (fixed[i] && fixed[j]) {
          // Two pinned cards the user parked on top of each other - their call.
          continue;
        }

        anyOverlap = true;
        moved = true;

        // Resolve along whichever axis needs the smaller shove. `|| 1` breaks the
        // tie when two centres coincide exactly.
        let shiftX = 0;
        let shiftY = 0;
        if (penX < penY) {
          shiftX = (dx < 0 ? -1 : 1) * penX || 1;
        } else {
          shiftY = (dy < 0 ? -1 : 1) * penY || 1;
        }

        if (fixed[i]) {
          pos[j].x += shiftX;
          pos[j].y += shiftY;
        } else if (fixed[j]) {
          pos[i].x -= shiftX;
          pos[i].y -= shiftY;
        } else {
          pos[i].x -= shiftX / 2;
          pos[i].y -= shiftY / 2;
          pos[j].x += shiftX / 2;
          pos[j].y += shiftY / 2;
        }
      }
    }

    if (!anyOverlap) {
      break;
    }
  }

  if (!moved) {
    return slots;
  }
  // Snap to whole pixels: fractional coordinates make cards render on sub-pixel
  // boundaries, whose measured height jitters and retriggers the layout.
  return new Map(
    entries.map(([key, slot], i) => {
      const x = Math.round(pos[i].x);
      const y = Math.round(pos[i].y);
      const same = x === slot.position.x && y === slot.position.y;
      return [key, same ? slot : { ...slot, position: { x, y } }];
    }),
  );
}

/**
 * Puts every manually positioned note at its dragged spot and re-opens space
 * around them - no ELK run. What a drop does, so the released card keeps its
 * exact spot while its neighbours shift out of the way.
 */
export function applyManualPositions(layout: GraphLayout, manualPositions: ReadonlyMap<string, XYPosition>): GraphLayout {
  const slots = new Map(layout.slots);
  for (const [key, position] of manualPositions) {
    const slot = slots.get(key);
    if (slot) {
      slots.set(key, { ...slot, position });
    }
  }
  return { ...layout, slots: separateOverlaps(slots, new Set(manualPositions.keys())) };
}

/**
 * Runs ELK over the graph with every note's real height and returns its slots.
 *
 * - `previous` seeds ELK's interactive mode so unrelated nodes stay put across
 *   graph changes; a note without a previous slot is seeded next to the anchor.
 * - `manualPositions` (notes the user dragged) override ELK's coordinate for
 *   those notes and pin them through the final separateOverlaps pass, so a
 *   dragged card keeps its spot and its neighbours open space around it.
 */
export async function computeLayout(
  graph: NoteGraph,
  heights: ReadonlyMap<string, number>,
  previous: GraphLayout,
  anchorKey: string | null,
  manualPositions: ReadonlyMap<string, XYPosition>,
): Promise<GraphLayout> {
  const knownKeys = new Set(graph.nodes.map((note) => note.key));
  const heightOf = (key: string): number => heights.get(key) ?? 0;
  const seed = seedPosition(previous, anchorKey);

  const elkGraph: ElkNode = {
    id: 'root',
    layoutOptions: ELK_LAYOUT_OPTIONS,
    children: graph.nodes.map((note) => {
      const height = heightOf(note.key);
      // Seeds are centre positions, converted to ELK's top-left convention.
      const start = previous.slots.get(note.key)?.position ?? seed;

      return {
        id: note.key,
        width: NODE_WIDTH,
        height,
        ...(start ? { x: start.x - NODE_WIDTH / 2, y: start.y - height / 2 } : {}),
      };
    }),
    // ELK throws if an edge references a node id not present in `children` above -
    // defend against that even though buildGraph doesn't make one.
    //
    // Every edge gets the same fixed label footprint (see estimateEdgeLabelSize) so
    // ELK reserves room for it between layers - this runs against the graph's raw,
    // pre-merge relation list, so a reciprocal pair (merged into one labeled edge by
    // mergeRelationsIntoEdges at render time) reserves space twice. That's a harmless
    // over-estimate, not a bug: it only makes the gap roomier than the single merged
    // label actually needs.
    edges: graph.edges
      .filter((edge) => knownKeys.has(edge.source) && knownKeys.has(edge.target))
      .map(
        (edge): ElkExtendedEdge => ({
          id: edge.id,
          sources: [edge.source],
          targets: [edge.target],
          labels: edge.inline ? [] : [{ text: edge.label ?? UNLABELLED, ...estimateEdgeLabelSize() }],
        }),
      ),
  };

  const layout = await elk.layout(elkGraph);

  // No single "center" to anchor to with multiple simultaneous pins - use ELK's raw
  // coordinates directly; the viewport is reframed whenever positions change, so
  // the absolute coordinate origin is never visible to the user.
  const slots = new Map<string, NodeSlot>(
    (layout.children ?? []).map((node) => {
      const height = heightOf(node.id);
      return [
        node.id,
        {
          // Whole pixels only - see the snap note in separateOverlaps.
          position: {
            x: Math.round((node.x ?? 0) + NODE_WIDTH / 2),
            y: Math.round((node.y ?? 0) + height / 2),
          },
          width: NODE_WIDTH,
          height,
        },
      ];
    }),
  );

  // `layered` ignores a seed coordinate for placement, so put dragged notes back
  // where the user left them and pin them through the separation pass below.
  const pinned = new Set<string>();
  for (const [key, position] of manualPositions) {
    const slot = slots.get(key);
    if (slot) {
      slots.set(key, { ...slot, position });
      pinned.add(key);
    }
  }

  return { slots: separateOverlaps(slots, pinned), structure: layoutStructureKey(graph) };
}
