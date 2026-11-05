import type { Edge } from '@xyflow/react';
import type { HiddenRelationsFlowNode } from './HiddenRelationsNode';
import type { NoteGraph } from './graph';
import { HIDDEN_BADGE_GAP, type GraphLayout } from './layout';
import { FOLLOWER_NODE_CLASS_NAME, NODE_CLASS_NAME } from './nodeStyle';

/** The pin depth at which all of a note's direct relations show: what clicking its hidden-relations badge pins. */
export const EXPAND_PIN_DEPTH = 1;

/**
 * Whether pinning at EXPAND_PIN_DEPTH would change anything. When it wouldn't (pinned that deep already), what's
 * still hidden is held back by the graph's caps, which pinning again can't lift.
 */
export function needsExpansion(pinDepth: number | null): boolean {
  return pinDepth === null || pinDepth < EXPAND_PIN_DEPTH;
}

const ID_PREFIX = 'hidden:';
const EDGE_STYLE = { strokeWidth: 1.2, opacity: 0.58 };

/**
 * A small badge below every placed note with related notes off the canvas, joined to it by an unlabelled edge. None
 * of it is part of the graph or goes through ELK (the wider node gap leaves the room).
 *
 * Each badge is a React Flow child of its note (`parentId`), so it follows the note when that's dragged. Its position
 * is relative to the note's top-left corner and its origin is top-centre, so it needs only the card's slot size. It
 * can't be dragged, selected, deleted or connected to.
 */
export function buildHiddenRelations(
  graph: NoteGraph,
  layout: GraphLayout,
  pins: ReadonlyMap<string, number>,
  onExpand: (key: string) => void,
): { nodes: HiddenRelationsFlowNode[]; edges: Edge[] } {
  const nodes: HiddenRelationsFlowNode[] = [];
  const edges: Edge[] = [];
  for (const { key, hiddenNeighbors } of graph.nodes) {
    const slot = layout.slots.get(key);
    if (!slot || hiddenNeighbors === 0) continue;
    const id = `${ID_PREFIX}${key}`;
    nodes.push({
      id,
      type: 'hiddenRelations',
      parentId: key,
      origin: [0.5, 0],
      position: { x: slot.width / 2, y: slot.height + HIDDEN_BADGE_GAP },
      className: `${NODE_CLASS_NAME} ${FOLLOWER_NODE_CLASS_NAME}`,
      draggable: false,
      selectable: false,
      connectable: false,
      deletable: false,
      focusable: false,
      data: { key, hiddenCount: hiddenNeighbors, expandable: needsExpansion(pins.get(key) ?? null), onExpand },
    });
    edges.push({ id: `${id}__edge`, source: key, target: id, type: 'floating', selectable: false, focusable: false, deletable: false, style: EDGE_STYLE });
  }
  return { nodes, edges };
}
