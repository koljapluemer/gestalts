import { Position, type InternalNode } from '@xyflow/react';

// Nodes and the edge-label-renderer layer are unstacked siblings with no z-index
// of their own (see @xyflow/react/dist/style.css), so without an explicit value
// here a note card painted after an edge in the DOM always covers that edge's
// label/form. Pick something comfortably above the notes (see
// GraphCanvas) so an interactive edge form never ends up trapped behind a note.
export const EDGE_OVERLAY_Z_INDEX = 1001;

interface Point {
  x: number;
  y: number;
}

export interface EdgeParams {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  sourcePos: Position;
  targetPos: Position;
}

/**
 * Finds where the straight line between two nodes' centers crosses
 * `intersectionNode`'s rectangle, using live measured position/size rather
 * than layout-time estimates. Standard "floating edges" formula from the
 * React Flow docs (https://reactflow.dev/examples/edges/floating-edges).
 */
function getNodeIntersection(intersectionNode: InternalNode, targetNode: InternalNode): Point {
  const w = (intersectionNode.measured.width ?? 0) / 2;
  const h = (intersectionNode.measured.height ?? 0) / 2;

  const intersectionNodePosition = intersectionNode.internals.positionAbsolute;
  const targetPosition = targetNode.internals.positionAbsolute;

  const x2 = intersectionNodePosition.x + w;
  const y2 = intersectionNodePosition.y + h;
  const x1 = targetPosition.x + (targetNode.measured.width ?? 0) / 2;
  const y1 = targetPosition.y + (targetNode.measured.height ?? 0) / 2;

  const xx1 = (x1 - x2) / (2 * w) - (y1 - y2) / (2 * h);
  const yy1 = (x1 - x2) / (2 * w) + (y1 - y2) / (2 * h);
  const a = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1);

  return {
    x: w * (a * xx1 + a * yy1) + x2,
    y: h * (-a * xx1 + a * yy1) + y2,
  };
}

function getEdgePosition(node: InternalNode, intersectionPoint: Point): Position {
  const { x: nx, y: ny } = node.internals.positionAbsolute;
  const width = node.measured.width ?? 0;
  const height = node.measured.height ?? 0;
  const px = Math.round(intersectionPoint.x);
  const py = Math.round(intersectionPoint.y);

  if (px <= Math.round(nx) + 1) return Position.Left;
  if (px >= Math.round(nx + width) - 1) return Position.Right;
  if (py <= Math.round(ny) + 1) return Position.Top;
  if (py >= Math.round(ny + height) - 1) return Position.Bottom;
  return Position.Top;
}

export function getEdgeParams(source: InternalNode, target: InternalNode): EdgeParams {
  const sourceIntersection = getNodeIntersection(source, target);
  const targetIntersection = getNodeIntersection(target, source);

  return {
    sx: sourceIntersection.x,
    sy: sourceIntersection.y,
    tx: targetIntersection.x,
    ty: targetIntersection.y,
    sourcePos: getEdgePosition(source, sourceIntersection),
    targetPos: getEdgePosition(target, targetIntersection),
  };
}
