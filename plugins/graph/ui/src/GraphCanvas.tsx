import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Background, Panel, ReactFlow, useReactFlow, type XYPosition } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { FilePlus, Layers, Maximize, Pin, PinOff, Search, Unplug, ZoomIn, ZoomOut } from 'lucide-react';
import { noteLabel, useHost, type Repo } from '@gestalts/sdk';
import { Modal, NewNote, NotePicker } from '@gestalts/kit';
import { FloatingEdge } from './FloatingEdge';
import { SCOPE, randomKey } from './graph';
import { HiddenRelationsNode } from './HiddenRelationsNode';
import { IDLE, type Interaction } from './interaction';
import { NoteNode } from './NoteNode';
import { FOLLOWERS_STOP_GLIDING_CLASS_NAME } from './nodeStyle';
import { PendingConnectionEdge } from './PendingConnectionEdge';
import { MANUAL_PIN_DEPTH, PIN_ALL_CAP, PIN_ALL_DEPTH, SEARCH_PIN_DEPTH, type UseGraph } from './useGraph';
import { useElkLayout } from './useElkLayout';
import { useFitViewOnReframe } from './useFitViewOnReframe';
import { useGraphActions } from './useGraphActions';
import { useGraphNodes } from './useGraphNodes';

const edgeTypes = { floating: FloatingEdge, pendingConnection: PendingConnectionEdge };
const nodeTypes = { note: NoteNode, hiddenRelations: HiddenRelationsNode };

const CONNECTION_RADIUS = 200;
const NOTICE_MS = 4000;

/**
 * The canvas: `useElkLayout` places the cards, `useGraphActions` owns the gestures and the writes, and
 * `useGraphNodes` carries the derived view into React Flow's node state (so a drag is React Flow's, not a re-render
 * of the whole graph). `searchResults`: the search sidebar's results while it filters, for the toolbar's search actions.
 */
export function GraphCanvas({ repo, g, searchResults }: { repo: Repo; g: UseGraph; searchResults: string[] | null }) {
  const rf = useReactFlow();
  const onOpen = useHost().openNote;
  const [interaction, setInteraction] = useState<Interaction>(IDLE);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // the drag lifecycle, here so the layout and the node sync stay in step: a drag pauses both, and a drop patches
  // the layout with the dropped position without running ELK
  const manualPositions = useRef<Map<string, XYPosition>>(new Map());
  const [dragging, setDragging] = useState(false);
  const { committed, anchorKey, markInteraction, applyManualDrop } = useElkLayout({ graph: g.graph, pins: g.pins, manualPositionsRef: manualPositions, dragging });
  useFitViewOnReframe(committed);

  const a = useGraphActions({ repo, g, setInteraction, markInteraction, onOpen });
  const { nodes, edges, onNodesChange, onNodeDragStart, onNodeDragStop } = useGraphNodes({
    graph: g.graph,
    notes: g.view.notes,
    layout: committed.layout,
    pins: g.pins,
    interaction,
    anchorKey,
    callbacks: a.callbacks,
    manualPositionsRef: manualPositions,
    dragging,
    onDragStart: () => setDragging(true),
    onDragStop: () => setDragging(false),
    onManualDrop: applyManualDrop,
  });

  const pinRandom = (orphan: boolean) => {
    const key = randomKey(g.view, g.pins.keys(), orphan);
    if (key) g.pin(key, MANUAL_PIN_DEPTH);
    else setNotice(orphan ? 'No orphan notes left that aren\'t pinned.' : 'No notes left that aren\'t pinned.');
  };
  const found = searchResults?.filter((k) => g.view.notes.has(k)) ?? null;
  const pinAllFound = () => {
    if (!found) return;
    g.pinAll(found.slice(0, PIN_ALL_CAP), PIN_ALL_DEPTH);
    if (found.length > PIN_ALL_CAP) setNotice(`Pinned the first ${PIN_ALL_CAP} of ${found.length} results.`);
  };
  const randomFound = () => {
    if (found?.length) g.pin(found[Math.floor(Math.random() * found.length)], SEARCH_PIN_DEPTH);
  };

  return (
    <ReactFlow
      colorMode="system"
      className={dragging ? FOLLOWERS_STOP_GLIDING_CLASS_NAME : ''}
      nodeOrigin={[0.5, 0.5]}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesConnectable
      nodesDraggable
      // selection stays on: React Flow gives a node wrapper `pointer-events: none` unless it's selectable or
      // draggable. Nothing renders selection, so the only effect to switch off is the z-raise.
      nodesFocusable={false}
      elevateNodesOnSelect={false}
      onNodesChange={onNodesChange}
      onNodeDragStart={onNodeDragStart}
      onNodeDragStop={onNodeDragStop}
      deleteKeyCode={null}
      connectionRadius={CONNECTION_RADIUS}
      onConnectStart={a.onConnectStart}
      onConnectEnd={a.onConnectEnd}
      onDoubleClick={a.onPaneDoubleClick}
      onPaneContextMenu={a.onPaneContextMenu}
      zoomOnDoubleClick={false}
      connectionLineStyle={{ strokeWidth: 1.6, strokeDasharray: '4 4' }}
      minZoom={0.02}
      maxZoom={1.5}
      panOnScroll
      proOptions={{ hideAttribution: true }}
      defaultEdgeOptions={{ type: 'floating', zIndex: 0 }}
    >
      <Background gap={28} />
      <Panel position="top-left" className="flex flex-wrap items-center gap-1">
        <Tool title="New note (or double-click the canvas)" onClick={a.addNote}><FilePlus className="size-4" /></Tool>
        <Tool title="Unpin all" onClick={g.clear} disabled={g.pins.size === 0}><PinOff className="size-4" /></Tool>
        <Tool title="Pin a random note" onClick={() => pinRandom(false)}><Layers className="size-4" /></Tool>
        <Tool title="Pin a random note without relationships" onClick={() => pinRandom(true)}><Unplug className="size-4" /></Tool>
        <Tool title="Pin a random search result" onClick={randomFound} disabled={!found?.length}><Search className="size-4" /></Tool>
        <Tool title={`Pin all search results (the first ${PIN_ALL_CAP}, without their neighbours)`} onClick={pinAllFound} disabled={!found?.length}><Pin className="size-4" /></Tool>
        <span className="mx-1 h-5 border-l border-base-300" />
        <Tool title="Zoom in" onClick={() => void rf.zoomIn({ duration: 150 })}><ZoomIn className="size-4" /></Tool>
        <Tool title="Zoom out" onClick={() => void rf.zoomOut({ duration: 150 })}><ZoomOut className="size-4" /></Tool>
        <Tool title="Fit the view" onClick={() => void rf.fitView({ duration: 200 })}><Maximize className="size-4" /></Tool>
      </Panel>
      {(g.graph.nodes.length === 0 && interaction.type === 'idle') || g.graph.warnings.length > 0 || notice ? (
        <Panel position="top-center" className="!mt-14 flex flex-col items-center gap-1">
          {g.graph.nodes.length === 0 && interaction.type === 'idle' && (
            <div className="pointer-events-none rounded-full border border-base-300 bg-base-100/90 px-4 py-2 text-sm text-base-content/70 shadow">
              Pin a note from the search, or right-click the canvas.
            </div>
          )}
          {g.graph.warnings.map((w) => <div key={w} className="rounded-full bg-warning/20 px-3 py-1 text-xs">{w}</div>)}
          {notice && <div className="rounded-full border border-base-300 bg-base-100 px-3 py-1 text-xs shadow">{notice}</div>}
        </Panel>
      ) : null}
      {a.undo && (
        <Panel position="bottom-center">
          <div className="flex items-center gap-3 rounded-full border border-base-300 bg-base-100 px-4 py-2 text-sm shadow-lg">
            <span>{a.undo.message}</span>
            <button type="button" className="btn btn-ghost btn-xs text-accent" onClick={a.performUndo}>Undo</button>
            <button type="button" className="btn btn-ghost btn-xs" onClick={a.dismissUndo}>Dismiss</button>
          </div>
        </Panel>
      )}
      {interaction.type === 'create' && (
        <Modal onClose={a.cancel}>
          <div className="px-4 pb-4">
            {interaction.source && <p className="mb-2 text-sm text-base-content/60">Related from <b>{labelOf(repo, interaction.source)}</b>.</p>}
            <NewNote onCreated={(key) => void a.onCreated(key, interaction.source).catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)))}
                     onCancel={a.cancel} />
          </div>
        </Modal>
      )}
      {interaction.type === 'search' && (
        <SearchMenu at={interaction.screenPosition} onPick={a.pinFromSearch} onClose={a.cancel} />
      )}
    </ReactFlow>
  );
}

const labelOf = (repo: Repo, key: string) => {
  const n = repo.get(key);
  return n ? noteLabel(n) : key;
};

function Tool({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return <button type="button" className="btn btn-sm btn-square bg-base-100" title={title} disabled={disabled} onClick={onClick}>{children}</button>;
}

/**
 * The right-click search, at the cursor: picking a result pins it, and the menu stays, so one search pins several
 * notes. Esc or a click elsewhere closes it.
 */
function SearchMenu({ at, onPick, onClose }: { at: { x: number; y: number }; onPick: (key: string) => void; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- only keeps the browser's menu away
    <div ref={root} className="nodrag nopan nowheel fixed z-50 w-80 rounded-box border border-base-300 bg-base-100 p-2 shadow-xl"
         style={{ left: Math.min(at.x, window.innerWidth - 330), top: Math.min(at.y, window.innerHeight - 360) }}
         onContextMenu={(e) => e.preventDefault()}>
      <NotePicker autofocus query={SCOPE} placeholder="Pin a note…" onPick={onPick} />
    </div>
  );
}
