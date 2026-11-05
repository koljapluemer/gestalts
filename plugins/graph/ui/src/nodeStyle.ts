/**
 * Resets React Flow's own node-wrapper styling and marks the wrapper as a hover `group`, so a card's connect handles
 * can show on hover. `transition-transform` glides a node to its new spot when the layout changes; React Flow moves
 * nodes by `transform` on this element, so the transition is off while it's dragged (`.dragging`, React Flow's
 * class). Nodes following a dragged parent never get `.dragging`: see FOLLOWER_NODE_CLASS_NAME.
 */
export const NODE_CLASS_NAME =
  'group border-0 bg-transparent shadow-none p-0 transition-transform duration-300 ease-in-out [&.dragging]:transition-none';

/**
 * A node React Flow positions relative to a parent (hiddenRelations.ts). It moves with the parent but is never
 * `.dragging` itself, so the canvas gets FOLLOWERS_STOP_GLIDING_CLASS_NAME while a drag lasts. (Not written against
 * React Flow's `react-flow__*` classes: Tailwind reads the `__` in an arbitrary variant as a space.)
 */
export const FOLLOWER_NODE_CLASS_NAME = 'follower-node';
export const FOLLOWERS_STOP_GLIDING_CLASS_NAME = '[&_.follower-node]:transition-none';
