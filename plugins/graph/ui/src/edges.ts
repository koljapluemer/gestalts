import { MarkerType, type Edge, type XYPosition } from '@xyflow/react';
import type { GraphEdge } from './graph';

/**
 * Turns the graph's flat relation list into React Flow edges. Pairs of
 * reciprocal relations are collapsed into a single visual edge (see
 * buildReciprocalEdge) so their two labels render merged instead of stacked.
 *
 * This is the *only* place that merging happens - callers must feed it the
 * complete current relation list rather than merging in separate passes, since a
 * merged edge's id no longer matches either of its inputs' raw ids and so can't
 * be reconciled against after the fact.
 */
export function mergeRelationsIntoEdges(relations: GraphEdge[], positions: Map<string, XYPosition>): Edge[] {
  const pairGroups = new Map<string, GraphEdge[]>();
  for (const relation of relations) {
    const pairKey = [relation.source, relation.target].sort().join('__');
    const group = pairGroups.get(pairKey);
    if (group) {
      group.push(relation);
    } else {
      pairGroups.set(pairKey, [relation]);
    }
  }

  const edges: Edge[] = [];
  for (const group of pairGroups.values()) {
    if (group.length === 2 && isReciprocalPair(group[0], group[1])) {
      edges.push(buildReciprocalEdge(group[0], group[1], positions));
    } else {
      for (const relation of group) {
        edges.push(buildDirectedEdge(relation));
      }
    }
  }

  return edges;
}

function isReciprocalPair(a: GraphEdge, b: GraphEdge): boolean {
  return a.inline === b.inline && a.source !== a.target && a.source === b.target && a.target === b.source;
}

function edgeVisualWeight(edge: GraphEdge): { strokeWidth: number; opacity: number } {
  return {
    strokeWidth: edge.depth === 1 ? 1.7 : 1.2,
    opacity: edge.depth === 1 ? 0.88 : 0.58,
  };
}

function buildDirectedEdge(edge: GraphEdge): Edge {
  const weight = edgeVisualWeight(edge);
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: 'floating',
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 16,
      height: 16,
    },
    style: { ...weight, ...(edge.inline ? { strokeDasharray: '5 4' } : {}) },
    data: { relations: [edge] },
  };
}

function buildReciprocalEdge(a: GraphEdge, b: GraphEdge, positions: Map<string, XYPosition>): Edge {
  const posA = positions.get(a.source) ?? { x: 0, y: 0 };
  const posB = positions.get(b.source) ?? { x: 0, y: 0 };
  const aGoesFirst = posA.x - posB.x || posA.y - posB.y;
  const [first, second] = aGoesFirst <= 0 ? [a, b] : [b, a];

  const weight = edgeVisualWeight(first.depth <= second.depth ? first : second);
  return {
    id: `${first.id}__reciprocal__${second.id}`,
    source: first.source,
    target: first.target,
    type: 'floating',
    markerStart: {
      type: MarkerType.ArrowClosed,
      width: 16,
      height: 16,
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 16,
      height: 16,
    },
    style: { ...weight, ...(first.inline ? { strokeDasharray: '5 4' } : {}) },
    data: { relations: [first, second] },
  };
}
