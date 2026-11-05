import type { Edge } from '@xyflow/react';
import type { IndexedNote } from '@gestalts/sdk';
import type { FloatingEdgeData } from './FloatingEdge';
import type { GraphEdge, NoteGraph } from './graph';
import type { HiddenRelationsFlowNode } from './HiddenRelationsNode';
import { buildHiddenRelations } from './hiddenRelations';
import type { ConnectingInteraction, Interaction } from './interaction';
import { mergeRelationsIntoEdges } from './edges';
import { NODE_WIDTH, seedPosition, type GraphLayout } from './layout';
import type { NoteCallbacks, NoteFlowNode } from './NoteNode';
import { NODE_CLASS_NAME } from './nodeStyle';

/** Every node kind on the canvas, by React Flow's `type`. */
export type GraphFlowNode = NoteFlowNode | HiddenRelationsFlowNode;

export type ViewCallbacks = NoteCallbacks & Omit<FloatingEdgeData, 'relations'> & {
  onConfirmConnection: (connecting: ConnectingInteraction, label: string | null) => Promise<void>;
  onCancelInteraction: () => void;
  onExpandHiddenRelations: (key: string) => void;
};

/**
 * The one place where the graph, the ELK layout, the pins and the gesture in progress become what <ReactFlow> gets.
 * Pure, so the merge can be reasoned about apart from React's render cycle; `useGraphNodes` runs it and reconciles the
 * result into React Flow's node state.
 *
 * `layout` is authoritative for every placed card's position, dragged ones included (the layout pins those). A card
 * without a slot yet is rendered invisibly at its seed position, only so React Flow measures it; the layout places it
 * once its height is known. Edges and badges are drawn between placed cards only.
 */
export function buildView(
  graph: NoteGraph,
  notes: ReadonlyMap<string, IndexedNote>,
  layout: GraphLayout,
  pins: ReadonlyMap<string, number>,
  interaction: Interaction,
  anchorKey: string | null,
  callbacks: ViewCallbacks,
): { nodes: GraphFlowNode[]; edges: Edge[] } {
  const unplaced = seedPosition(layout, anchorKey) ?? { x: 0, y: 0 };
  const { onConfirmConnection, onCancelInteraction, onExpandHiddenRelations, onRelabel, onDeleteRelation, onOpenInline, ...noteCallbacks } = callbacks;

  const nodes: GraphFlowNode[] = graph.nodes.flatMap((n): NoteFlowNode[] => {
    const note = notes.get(n.key);
    if (!note) return [];
    const slot = layout.slots.get(n.key);
    // no `height`: the card sizes to its content and React Flow measures it
    return [{
      id: n.key,
      type: 'note',
      position: slot?.position ?? unplaced,
      width: slot?.width ?? NODE_WIDTH,
      className: slot ? NODE_CLASS_NAME : `${NODE_CLASS_NAME} invisible`,
      dragHandle: '.note-drag-handle',
      data: {
        ...noteCallbacks,
        note,
        pinDepth: pins.get(n.key) ?? null,
        othersPinned: pins.size > 1,
        isAnchor: n.key === anchorKey,
      },
    }];
  });

  const placed = new Set(layout.slots.keys());
  const positions = new Map([...layout.slots].map(([key, slot]) => [key, slot.position]));
  // only between placed cards: an edge into an invisible one would point at its seed position
  const relations: GraphEdge[] = graph.edges.filter((e) => placed.has(e.source) && placed.has(e.target));
  const edges: Edge[] = mergeRelationsIntoEdges(relations, positions).map((edge) => ({
    ...edge,
    data: { ...edge.data, onRelabel, onDeleteRelation, onOpenInline },
  }));

  // either note may have gone while the label was being typed
  if (interaction.type === 'connecting' && placed.has(interaction.source) && placed.has(interaction.target)) {
    edges.push({
      id: `pending:${interaction.source}->${interaction.target}`,
      source: interaction.source,
      target: interaction.target,
      type: 'pendingConnection',
      data: { onConfirm: (label: string | null) => onConfirmConnection(interaction, label), onCancel: onCancelInteraction },
    });
  }

  // last: React Flow needs a child node (the badge) after its parent
  const hidden = buildHiddenRelations(graph, layout, pins, onExpandHiddenRelations);
  return { nodes: [...nodes, ...hidden.nodes], edges: [...edges, ...hidden.edges] };
}
