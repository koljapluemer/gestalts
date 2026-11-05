import { memo, useState, type ReactNode } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ExternalLink, EyeOff, Focus, GripVertical, Trash2 } from 'lucide-react';
import { noteLabel, type IndexedNote } from '@gestalts/sdk';
import { NoteView } from '@gestalts/kit';
import { NODE_WIDTH } from './layout';
import { PinControl } from './PinControl';

export type NoteCallbacks = {
  /** the host's editor; without it nothing offers to open */
  onOpen?: (key: string) => void;
  onPin: (key: string) => void;
  onUnpin: (key: string) => void;
  onUnpinOthers: (key: string) => void;
  onChangeDepth: (key: string, next: number) => void;
  onHide: (key: string, pinDepth: number | null) => Promise<void>;
  onDelete: (key: string, pinDepth: number | null) => Promise<void>;
};

export type NoteNodeData = NoteCallbacks & {
  note: IndexedNote;
  /** hops shown around it, or null when it isn't pinned */
  pinDepth: number | null;
  /** whether any other note is pinned */
  othersPinned: boolean;
  /** the note new notes are placed next to: the one last acted on */
  isAnchor: boolean;
};

export type NoteFlowNode = Node<NoteNodeData, 'note'>;

const CONNECT_HANDLES = [Position.Top, Position.Right, Position.Bottom, Position.Left];

/**
 * A note on the canvas: its label, tools and body. Dragging a dot on its border onto another card relates the two;
 * dropping it on the canvas makes a new related note. Memoized: during a drag the other cards' `data` keep their
 * identity, so their Markdown isn't rendered again each frame.
 */
export const NoteNode = memo(function NoteNode({ data }: NodeProps<NoteFlowNode>) {
  const { note, pinDepth } = data;
  const [error, setError] = useState<string | null>(null);
  const act = (work: Promise<void>) => { setError(null); work.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))); };
  return (
    <>
      {/*
        One target handle over the whole card, with the canvas's generous connectionRadius, so any drop on the card
        resolves to it; edges into the card need some handle to render, though FloatingEdge draws from the card's box.
      */}
      <Handle type="target" position={Position.Top} className="pointer-events-none opacity-0"
              style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }} />
      {/* always mounted (React Flow needs them for the card's outgoing edges); shown as dots while hovering the card */}
      {CONNECT_HANDLES.map((position) => (
        <Handle key={position} id={position} type="source" position={position} title="Drag onto a note to relate them, or onto the canvas for a new note"
                className="pointer-events-none size-3.5 rounded-full border-2 border-base-100 bg-primary opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-90" />
      ))}
      <article style={{ width: NODE_WIDTH }}
               className={`cursor-auto select-text rounded-box border bg-base-100 text-left shadow-lg ${pinDepth !== null ? 'border-primary' : 'border-base-300'} ${data.isAnchor ? 'border-dashed' : ''}`}>
        <header className="flex items-center gap-0.5 border-b border-base-200 px-1 py-0.5">
          <span className="note-drag-handle cursor-grab p-1 text-base-content/40 active:cursor-grabbing" title="Drag to move"><GripVertical className="size-4" /></span>
          {data.onOpen
            ? <button type="button" className="nodrag min-w-0 flex-1 truncate text-left text-sm font-semibold hover:underline" title="Open" onClick={() => data.onOpen?.(note.key)}>{noteLabel(note)}</button>
            : <span className="min-w-0 flex-1 truncate text-sm font-semibold">{noteLabel(note)}</span>}
          <PinControl pinDepth={pinDepth} onPin={() => data.onPin(note.key)} onUnpin={() => data.onUnpin(note.key)}
                      onChangeDepth={(next) => data.onChangeDepth(note.key, next)} />
          {pinDepth !== null && data.othersPinned && (
            <Tool title="Unpin everything else" onClick={() => data.onUnpinOthers(note.key)}><Focus className="size-3.5" /></Tool>
          )}
          {data.onOpen && <Tool title="Open" onClick={() => data.onOpen?.(note.key)}><ExternalLink className="size-3.5" /></Tool>}
          <Tool title="Hide from the graph (tags it no-graph)" onClick={() => act(data.onHide(note.key, pinDepth))}><EyeOff className="size-3.5" /></Tool>
          <Tool title="Delete the note" onClick={() => act(data.onDelete(note.key, pinDepth))}><Trash2 className="size-3.5" /></Tool>
        </header>
        <div className="nowheel max-h-96 overflow-y-auto px-3 py-2 text-sm">
          <NoteView note={note} onOpen={data.onOpen} />
        </div>
        {error && <p role="alert" className="px-3 pb-2 text-xs text-error">{error}</p>}
      </article>
    </>
  );
});

function Tool({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return <button type="button" className="nodrag btn btn-ghost btn-xs btn-square" title={title} onClick={onClick}>{children}</button>;
}
