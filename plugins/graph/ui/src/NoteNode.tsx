import { memo, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { EyeOff, Focus, GripVertical } from 'lucide-react';
import type { IndexedNote } from '@gestalts/sdk';
import { Note, type ExtraTool } from '@gestalts/kit';
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
  /** the card shows its editor (one at a time) */
  onStartEdit: (key: string) => void;
  onStopEdit: () => void;
};

export type NoteNodeData = NoteCallbacks & {
  note: IndexedNote;
  /** hops shown around it, or null when it isn't pinned */
  pinDepth: number | null;
  /** whether any other note is pinned */
  othersPinned: boolean;
  /** the note new notes are placed next to: the one last acted on */
  isAnchor: boolean;
  /** the card shows its editor */
  editing: boolean;
};

export type NoteFlowNode = Node<NoteNodeData, 'note'>;

const CONNECT_HANDLES = [Position.Top, Position.Right, Position.Bottom, Position.Left];

/**
 * A note on the canvas: the note component, read or edited (one card at a time, as the graph's interaction has it),
 * its relationships being the edges; the grip, pin, unpin-others and hide as its own tools, delete with the graph's
 * undo. Dragging a dot on its border onto another card relates the two; dropping it on the canvas makes a new related
 * note. Memoized: during a drag the other cards' `data` keep their identity, so their Markdown isn't rendered again.
 */
export const NoteNode = memo(function NoteNode({ data }: NodeProps<NoteFlowNode>) {
  const { note, pinDepth } = data;
  const [error, setError] = useState<string | null>(null);
  const act = (work: Promise<void>) => { setError(null); work.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))); };
  const tools: ExtraTool[] = [
    {
      key: 'grip',
      // the only drag surface (`dragHandle` in the view model), so the rest of the card stays free for selecting text
      node: <span className="note-drag-handle cursor-grab p-1 text-base-content/40 active:cursor-grabbing" title="Drag to move"><GripVertical className="size-4" /></span>,
    },
    {
      key: 'pin',
      node: <PinControl pinDepth={pinDepth} onPin={() => data.onPin(note.key)} onUnpin={() => data.onUnpin(note.key)} onChangeDepth={(next) => data.onChangeDepth(note.key, next)} />,
    },
    ...(pinDepth !== null && data.othersPinned ? [{ key: 'unpinOthers', title: 'Unpin everything else', icon: <Focus className="size-3.5" />, onClick: () => data.onUnpinOthers(note.key) }] : []),
    { key: 'hide', title: 'Hide from the graph (tags it no-graph)', icon: <EyeOff className="size-3.5" />, onClick: () => act(data.onHide(note.key, pinDepth)) },
  ];
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
               className={`cursor-auto select-text rounded-box shadow-lg ${pinDepth !== null ? '[&_.card]:border-primary' : ''} ${data.isAnchor || data.editing ? '[&_.card]:border-dashed' : ''}`}>
        <div className={data.editing ? 'nowheel' : 'nowheel max-h-96 overflow-y-auto rounded-box'}>
          <Note noteKey={note.key} compact relationships={false} extraTools={tools} mode={data.editing ? 'edit' : 'view'}
                onModeChange={(next) => (next === 'edit' ? data.onStartEdit(note.key) : data.onStopEdit())} onEscape={data.onStopEdit}
                onOpen={data.onOpen} onDelete={async () => { await data.onDelete(note.key, pinDepth); return true; }} />
        </div>
        {error && <p role="alert" className="px-3 pb-2 text-xs text-error">{error}</p>}
      </article>
    </>
  );
});
