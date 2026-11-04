import { createContext, useContext, useEffect, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  Background, Controls, Panel, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow, type Node, type NodeChange, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ExternalLink, FilePlus2, GripVertical, Maximize, Pencil, Plus, RotateCcw, StickyNote, Trash2, Type, Undo2, Unlink } from 'lucide-react';
import { noteLabel, str, useNote, type IndexedNote, type Json, type Query, type Repo, definePerspective } from '@gestalts/sdk';
import { Markdown, NotePicker } from '@gestalts/kit';
import { OLD_CANVASES, canvasOf, resolveStale, saveCanvas } from './canvasNote';
import { canvasReducer, fromWire, nodeId, sameNodes, toWire, type CanvasAction, type CanvasNode } from './model';
import { CanvasSaver } from './saver';

type Props = {
  /** key of the note the canvas is about */
  host: string;
  /** a note was asked to be opened; without it nothing offers to */
  onOpen?: (key: string) => void;
  /** a note to add (its key); a new `seq` asks again */
  add?: { key: string; seq: number } | null;
};

/**
 * Any note as an infinite canvas of free Markdown text and linked notes, stored on it as `canvas` (`canvas@2`).
 * A canvas still in an old `canvas@1` note is shown, and folded into the note on the first change. Double-click the
 * canvas to write there.
 */
export const Canvas = definePerspective<{ canvases: Query }, Props>({
  id: 'canvas',
  title: 'Canvas',
  data: { canvases: OLD_CANVASES },
  Component: ({ data, repo, host, onOpen, add }) => {
    const hostNote = useNote(host);
    const [generation, setGeneration] = useState(0);
    if (!hostNote) return <p className="p-8 text-center text-base-content/60">No note <code>{host}</code>.</p>;
    const canvas = canvasOf(hostNote, data.canvases);
    return (
      <ReactFlowProvider>
        <Board key={`${host}:${generation}`} repo={repo} host={hostNote} stored={canvas.nodes} stale={canvas.stale}
               unwritable={canvas.unwritable} onOpen={onOpen} add={add} onReload={() => setGeneration((g) => g + 1)} />
      </ReactFlowProvider>
    );
  },
});

type Ctx = {
  repo: Repo;
  dispatch: (a: CanvasAction) => void;
  readOnly: boolean;
  editing: string | null;
  setEditing: (id: string | null) => void;
  remove: (id: string) => void;
  onOpen?: (key: string) => void;
};
const CanvasContext = createContext<Ctx | null>(null);
const useCanvas = () => useContext(CanvasContext)!;

type BoardProps = {
  repo: Repo;
  host: IndexedNote;
  /** the canvas's nodes as stored (on the host, or in an old canvas note) */
  stored: Json | undefined;
  /** old canvas notes edited after they were folded in */
  stale: IndexedNote[];
  /** why the host can't be written, if it can't */
  unwritable: string | null;
  onOpen?: (key: string) => void;
  add?: Props['add'];
  onReload: () => void;
};

function Board({ repo, host, stored, stale, unwritable, onOpen, add, onReload }: BoardProps) {
  const rf = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  // the canvas as opened: the only truth while it's open, so nothing arriving later overwrites what's being done
  const [initial] = useState(() => fromWire(stored));
  const [doc, dispatch] = useReducer(canvasReducer, initial.doc);
  const [saver] = useState(() => new CanvasSaver((nodes) => saveCanvas(repo, host.key, nodes), toWire(initial.doc)));
  const save = useSyncExternalStore(saver.subscribe, saver.get);
  const [conflict, setConflict] = useState(false);
  const readOnly = initial.problems.length > 0 || conflict || unwritable !== null;
  const [editing, setEditing] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ node: CanvasNode; index: number } | null>(null);
  const [picking, setPicking] = useState(false);

  // each change goes to the saver; the first render is the canvas as stored
  const opened = useRef(true);
  useEffect(() => {
    if (opened.current) { opened.current = false; return; }
    if (!readOnly) saver.change(toWire(doc));
  }, [doc, saver, readOnly]);

  // the nodes changed elsewhere (a sync, the raw editor) since this page last wrote them: stop writing, offer to
  // reload. Other changes to the host (its `main`, …) don't count.
  const storedText = JSON.stringify(stored ?? null);
  useEffect(() => {
    if (stored === undefined || !saver.idle) return;
    const now = toWire(fromWire(stored).doc);
    if (!sameNodes(now, saver.written)) setConflict(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `storedText` stands for `stored`
  }, [storedText, save, saver]);

  const resolve = async (note: IndexedNote, take: boolean) => {
    await saver.flush();
    await resolveStale(repo, host.key, note, take);
    if (take) onReload();
  };

  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') void saver.flush(); };
    document.addEventListener('visibilitychange', onHide);
    return () => { document.removeEventListener('visibilitychange', onHide); void saver.flush(); };
  }, [saver]);

  const [nodes, setNodes] = useState<Node[]>([]);
  useEffect(() => {
    setNodes((prev) => doc.nodes.map((n) => {
      const was = prev.find((p) => p.id === n.id);
      return { ...was, id: n.id, type: n.kind, position: { x: n.x, y: n.y }, data: { node: n }, dragHandle: '.canvas-grip' };
    }));
  }, [doc]);

  const at = (dx = 0) => {
    const r = wrapper.current?.getBoundingClientRect();
    const p = r ? rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 3 }) : { x: 0, y: 0 };
    return { x: Math.round(p.x + dx), y: Math.round(p.y + dx) };
  };
  const addNote = (noteKey: string) => {
    const id = repo.get(noteKey)?.id;
    if (!id || readOnly) return;
    dispatch({ type: 'add', node: { id: nodeId(doc), ...at(doc.nodes.length % 5 * 24), kind: 'note', note: id } });
  };
  const addText = (pos = at()) => {
    if (readOnly) return;
    const id = nodeId(doc);
    dispatch({ type: 'add', node: { id, ...pos, kind: 'text', text: '' } });
    setEditing(id);
  };
  const remove = (id: string) => {
    const index = doc.nodes.findIndex((n) => n.id === id);
    if (index < 0) return;
    setUndo({ node: doc.nodes[index], index });
    dispatch({ type: 'remove', id });
  };

  const seen = useRef(add?.seq);
  useEffect(() => {
    if (!add || add.seq === seen.current) return;
    seen.current = add.seq;
    addNote(add.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per request
  }, [add?.seq]);

  const ctx: Ctx = { repo, dispatch, readOnly, editing, setEditing, remove, onOpen };
  return (
    <CanvasContext value={ctx}>
      <div ref={wrapper} className="relative h-full min-h-[24rem] w-full"
           onDoubleClick={(e) => {
             if (!(e.target as HTMLElement).classList.contains('react-flow__pane')) return;
             const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
             addText({ x: Math.round(p.x), y: Math.round(p.y) });
           }}>
        <ReactFlow
          nodes={nodes}
          edges={[]}
          nodeTypes={NODE_TYPES}
          onNodesChange={(changes: NodeChange[]) => setNodes((ns) => applyNodeChanges(changes, ns))}
          onNodeDragStart={() => saver.hold(true)}
          onNodeDragStop={(_, node) => {
            saver.hold(false);
            dispatch({ type: 'move', id: node.id, x: Math.round(node.position.x), y: Math.round(node.position.y) });
          }}
          nodesDraggable={!readOnly}
          zoomOnDoubleClick={false}
          minZoom={0.1}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls showInteractive={false} />
          <Panel position="top-left" className="flex flex-wrap items-center gap-1">
            <Tool title="Add text (or double-click the canvas)" onClick={() => addText()} disabled={readOnly}><Type className="size-4" /></Tool>
            <Tool title="Add a note" onClick={() => setPicking(!picking)} disabled={readOnly}><Plus className="size-4" /></Tool>
            <Tool title="Fit the view" onClick={() => void rf.fitView({ padding: 0.2 })}><Maximize className="size-4" /></Tool>
            {onOpen && <Tool title={`Open ${noteLabel(host)}`} onClick={() => onOpen(host.key)}><ExternalLink className="size-4" /></Tool>}
            {undo && !readOnly && (
              <button type="button" className="btn btn-xs" onClick={() => { dispatch({ type: 'restore', ...undo }); setUndo(null); }}>
                <Undo2 className="size-3" /> Undo removal
              </button>
            )}
            <SaveBadge status={save.status} error={save.error} onRetry={() => saver.retry()} />
          </Panel>
          {picking && (
            <Panel position="top-left" className="!mt-12 w-80 rounded-box border border-base-300 bg-base-100 p-2 shadow">
              <NotePicker autofocus placeholder="Add a note to the canvas" onPick={(k) => { addNote(k); setPicking(false); }} />
            </Panel>
          )}
          {(readOnly || stale.length > 0) && (
            <Panel position="top-center" className="flex flex-col gap-1">
              {stale.map((n) => (
                <div key={n.key} role="alert" className="alert alert-warning alert-soft py-2 text-sm">
                  <span>The old canvas note <code className="text-xs">{n.key}</code> was changed elsewhere after this canvas moved into the note.</span>
                  <button type="button" className="btn btn-xs" onClick={() => void resolve(n, true)}>Use that version</button>
                  <button type="button" className="btn btn-xs" onClick={() => void resolve(n, false)}>Keep this one</button>
                </div>
              ))}
              {readOnly && <div role="alert" className="alert alert-warning alert-soft py-2 text-sm">
                {initial.problems.length
                  ? <span>This canvas can't be read, so it's read-only until it's fixed in the note: {initial.problems.join('; ')}</span>
                  : unwritable
                    ? <span>This canvas is read-only: {unwritable}.</span>
                    : <span>The canvas changed elsewhere. Nothing more is written here.</span>}
                {conflict && <button type="button" className="btn btn-xs" onClick={onReload}><RotateCcw className="size-3" /> Reload</button>}
              </div>}
            </Panel>
          )}
        </ReactFlow>
      </div>
    </CanvasContext>
  );
}

function Tool({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return <button type="button" className="btn btn-sm btn-square bg-base-100" title={title} disabled={disabled} onClick={onClick}>{children}</button>;
}

function SaveBadge({ status, error, onRetry }: { status: string; error: string | null; onRetry: () => void }) {
  if (status === 'saved') return null;
  if (status === 'error') return <button type="button" className="btn btn-xs btn-error" title={error ?? ''} onClick={onRetry}>Not saved: retry</button>;
  return <span className="badge badge-sm badge-ghost">{status === 'saving' ? 'saving…' : 'unsaved'}</span>;
}

type NodeData = { node: CanvasNode };

function Frame({ tools, children }: { tools: ReactNode; children: ReactNode }) {
  return (
    <div className="w-72 rounded-box border border-base-300 bg-base-100 shadow-sm">
      <div className="flex items-center gap-0.5 border-b border-base-200 px-1 py-0.5">
        <span className="canvas-grip cursor-grab p-1 text-base-content/40" title="Drag"><GripVertical className="size-3.5" /></span>
        <div className="flex-1" />
        {tools}
      </div>
      <div className="p-2 text-sm">{children}</div>
    </div>
  );
}

function NodeTool({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return <button type="button" className="btn btn-ghost btn-xs btn-square" title={title} onClick={onClick}>{children}</button>;
}

function TextNode({ data }: NodeProps<Node<NodeData>>) {
  const { repo, dispatch, readOnly, editing, setEditing, remove, onOpen } = useCanvas();
  const node = data.node as Extract<CanvasNode, { kind: 'text' }>;
  const [busy, setBusy] = useState(false);
  const isEditing = editing === node.id && !readOnly;
  const leave = () => {
    setEditing(null);
    if (!node.text.trim()) dispatch({ type: 'remove', id: node.id });
  };
  const toNote = async () => {
    setBusy(true);
    try {
      const made = await repo.putValue(undefined, { main: node.text });
      dispatch({ type: 'toNote', id: node.id, note: made.id });
    } finally { setBusy(false); }
  };
  return (
    <Frame tools={!readOnly && <>
      <NodeTool title={isEditing ? 'View' : 'Edit'} onClick={() => (isEditing ? leave() : setEditing(node.id))}><Pencil className="size-3.5" /></NodeTool>
      {node.text.trim() && <NodeTool title="Make it a note" onClick={() => { if (!busy) void toNote(); }}><FilePlus2 className="size-3.5" /></NodeTool>}
      <NodeTool title="Delete" onClick={() => remove(node.id)}><Trash2 className="size-3.5" /></NodeTool>
    </>}>
      {isEditing ? (
        <textarea
          className="nodrag nowheel textarea textarea-sm min-h-24 w-full font-mono"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- just opened for writing
          autoFocus
          value={node.text}
          onChange={(e) => dispatch({ type: 'setText', id: node.id, text: e.target.value })}
          onBlur={leave}
          onKeyDown={(e) => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); leave(); } }}
        />
      ) : (
        // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- double-click to edit, as on the canvas
        <div className="nowheel max-h-80 overflow-y-auto" onDoubleClick={() => !readOnly && setEditing(node.id)}>
          <Markdown text={node.text} onOpen={onOpen} />
        </div>
      )}
    </Frame>
  );
}

function NoteNode({ data }: NodeProps<Node<NodeData>>) {
  const { repo, dispatch, readOnly, remove, onOpen } = useCanvas();
  const node = data.node as Extract<CanvasNode, { kind: 'note' }>;
  const key = repo.keyOf(node.note);
  const note = useNote(key);
  if (!note) {
    return (
      <Frame tools={!readOnly && <NodeTool title="Detach" onClick={() => remove(node.id)}><Unlink className="size-3.5" /></NodeTool>}>
        <span className="text-base-content/50 line-through">Missing note</span> <code className="text-xs">{node.note}</code>
      </Frame>
    );
  }
  const main = str(note, 'main') ?? '';
  return (
    <Frame tools={<>
      {onOpen && <NodeTool title="Open" onClick={() => onOpen(note.key)}><ExternalLink className="size-3.5" /></NodeTool>}
      {!readOnly && main && <NodeTool title="Copy its text into a text node" onClick={() => dispatch({ type: 'toText', id: node.id, text: main })}><StickyNote className="size-3.5" /></NodeTool>}
      {!readOnly && <NodeTool title="Detach (the note stays)" onClick={() => remove(node.id)}><Unlink className="size-3.5" /></NodeTool>}
    </>}>
      {str(note, 'title') || !main ? <p className="font-semibold">{noteLabel(note)}</p> : null}
      {main && <div className="nowheel mt-1 max-h-60 overflow-y-auto"><Markdown text={main} onOpen={onOpen} /></div>}
    </Frame>
  );
}

const NODE_TYPES = { text: TextNode, note: NoteNode };
