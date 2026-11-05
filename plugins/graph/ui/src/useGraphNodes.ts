import { useNodesState, type Edge, type OnNodeDrag, type OnNodesChange, type XYPosition } from '@xyflow/react';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { GraphFlowNode } from './viewModel';
import type { Interaction } from './interaction';
import { buildView, type ViewCallbacks } from './viewModel';
import type { GraphLayout } from './layout';
import { share } from './share';
import type { IndexedNote } from '@gestalts/sdk';
import type { NoteGraph } from './graph';

interface GraphView {
  nodes: GraphFlowNode[];
  edges: Edge[];
}

const EMPTY_VIEW: GraphView = { nodes: [], edges: [] };

export interface UseGraphNodesParams {
  graph: NoteGraph;
  /** the graph's notes, by key */
  notes: ReadonlyMap<string, IndexedNote>;
  layout: GraphLayout;
  pins: ReadonlyMap<string, number>;
  interaction: Interaction;
  anchorKey: string | null;
  callbacks: ViewCallbacks;
  /** Notes the user has dragged, by key. Written here on drag end; pinned by the layout. */
  manualPositionsRef: RefObject<Map<string, XYPosition>>;
  /** True while a pointer drag is in progress - the view sync is suspended so it can't fight it. */
  dragging: boolean;
  onDragStart: () => void;
  onDragStop: () => void;
  /** Re-pins every manual position and separates neighbours around them (no ELK run). */
  onManualDrop: () => void;
}

export interface UseGraphNodesResult {
  nodes: GraphFlowNode[];
  edges: Edge[];
  onNodesChange: OnNodesChange<GraphFlowNode>;
  onNodeDragStart: OnNodeDrag<GraphFlowNode>;
  onNodeDragStop: OnNodeDrag<GraphFlowNode>;
}

/**
 * Bridges the derived view (buildView) and React Flow's own node state.
 *
 * React Flow owns `nodes` via `useNodesState`, so a drag mutates only the dragged
 * node in place - no per-frame rebuild of the whole array. A `useEffect`
 * re-derives the view whenever a layout / graph / pin / interaction input changes
 * (never during a drag). The view is structurally shared with the previous one,
 * so only nodes whose view actually changed are handed to React Flow as new
 * objects - everything else keeps its identity, its measured size and its
 * memoized render. This is React Flow's recommended shape for a flow whose nodes
 * also come from external data (see reactflow.dev/api-reference/hooks/use-nodes-state).
 */
export function useGraphNodes({
  graph,
  notes,
  layout,
  pins,
  interaction,
  anchorKey,
  callbacks,
  manualPositionsRef,
  dragging,
  onDragStart,
  onDragStop,
  onManualDrop,
}: UseGraphNodesParams): UseGraphNodesResult {
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphFlowNode>([]);
  // Edges are plain state: they carry no interaction changes we round-trip
  // (labels are edited straight through the API), so no `onEdgesChange`.
  const [edges, setEdges] = useState<Edge[]>(EMPTY_VIEW.edges);
  const lastViewRef = useRef<GraphView>(EMPTY_VIEW);

  // Sync the derived view into React Flow's node/edge state. Suspended during a
  // drag; `onManualDrop` has already patched the layout with the dropped position
  // by the time this re-runs on drag-end, so the released card doesn't snap back.
  useEffect(() => {
    if (dragging) {
      return;
    }

    const previous = lastViewRef.current;
    const view = share(previous, buildView(graph, notes, layout, pins, interaction, anchorKey, callbacks));
    if (view === previous) {
      return;
    }
    lastViewRef.current = view;

    setNodes((current) => syncNodes(current, previous.nodes, view.nodes));
    setEdges(view.edges);
  }, [graph, notes, layout, pins, interaction, anchorKey, callbacks, dragging, setNodes]);

  // A dragged position lives only while the note is on the canvas - forget it
  // once the note leaves the graph, so a re-pinned note returns to a freshly
  // computed slot. Ref-only: no state update, so nothing re-renders here.
  useEffect(() => {
    const present = new Set(graph.nodes.map((note) => note.key));
    for (const key of manualPositionsRef.current.keys()) {
      if (!present.has(key)) {
        manualPositionsRef.current.delete(key);
      }
    }
  }, [graph, manualPositionsRef]);

  const onNodeDragStart = useCallback<OnNodeDrag<GraphFlowNode>>(() => {
    onDragStart();
  }, [onDragStart]);

  const onNodeDragStop = useCallback<OnNodeDrag<GraphFlowNode>>(
    (_event, node) => {
      if (node.type === 'note') {
        // Whole pixels: a card on a sub-pixel x re-measures its height and
        // retriggers the layout (see separateOverlaps).
        manualPositionsRef.current.set(node.id, {
          x: Math.round(node.position.x),
          y: Math.round(node.position.y),
        });
        // Patch the layout in place with the drop position + a separation pass,
        // then let the view sync resume - the card stays exactly where released.
        onManualDrop();
      }
      onDragStop();
    },
    [manualPositionsRef, onDragStop, onManualDrop],
  );

  return { nodes, edges, onNodesChange, onNodeDragStart, onNodeDragStop };
}

/**
 * Carries a new view into React Flow's node array. A view node identical to the
 * previous view's keeps React Flow's current object (with its measured size and
 * any in-flight state); a changed one replaces it immutably but keeps `measured`,
 * so React Flow doesn't treat the node as unmeasured and re-adopt it from scratch.
 */
function syncNodes(current: GraphFlowNode[], previousView: GraphFlowNode[], nextView: GraphFlowNode[]): GraphFlowNode[] {
  const currentById = new Map(current.map((node) => [node.id, node]));
  const previousViewById = new Map(previousView.map((node) => [node.id, node]));

  const synced = nextView.map((viewNode) => {
    const existing = currentById.get(viewNode.id);
    if (!existing) {
      return viewNode;
    }
    if (previousViewById.get(viewNode.id) === viewNode) {
      return existing;
    }
    return { ...viewNode, measured: existing.measured };
  });

  const unchanged = synced.length === current.length && synced.every((node, index) => node === current[index]);
  return unchanged ? current : synced;
}
