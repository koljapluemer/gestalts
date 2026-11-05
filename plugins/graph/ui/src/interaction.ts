import type { InternalNode } from '@xyflow/react';

/**
 * What the user is doing on the canvas beyond looking at it. One union, so the gestures exclude each other: there is
 * never a card in edit and a pending connection at once. (A new note is the host's, over the pane.)
 */
export type Interaction =
  | { type: 'idle' }
  /** the card of `key` shows its editor: one at a time */
  | { type: 'edit'; key: string }
  | ConnectingInteraction
  /** the right-click search, at viewport (clientX/clientY) coordinates */
  | { type: 'search'; screenPosition: { x: number; y: number } };

/** A relationship dragged from `source` onto `target`, waiting for its label. */
export type ConnectingInteraction = { type: 'connecting'; source: string; target: string };

export const IDLE: Interaction = { type: 'idle' };

/**
 * The note a connection drag ended on, or null. React Flow resolves the drop to the nearest handle within
 * `connectionRadius`, even one that isn't connectable, so it can be a hidden-relations badge: that sits right under
 * its note, so a drop on it means that note.
 */
export function connectionTarget(toNode: InternalNode | null): string | null {
  if (!toNode) return null;
  return toNode.type === 'hiddenRelations' ? (toNode.parentId ?? null) : toNode.id;
}
