import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';

export type HiddenRelationsNodeData = {
  /** the note the badge hangs off: the one pinned when it's clicked */
  key: string;
  /** how many notes related to `key` aren't on the canvas; always > 0 */
  hiddenCount: number;
  /** false once pinning `key` again would change nothing (see needsExpansion) */
  expandable: boolean;
  onExpand: (key: string) => void;
};

export type HiddenRelationsFlowNode = Node<HiddenRelationsNodeData, 'hiddenRelations'>;

/** Memoized: while a note is dragged React Flow re-renders every node each frame, but this one's `data` keeps its identity. */
export const HiddenRelationsNode = memo(function HiddenRelationsNode({ data }: NodeProps<HiddenRelationsFlowNode>) {
  return (
    <>
      {/* only so React Flow can resolve an end for the note -> badge edge; never a connection target (connectionTarget) */}
      <Handle type="target" position={Position.Top} isConnectable={false} className="pointer-events-none opacity-0" />
      {/* the node wrapper gets `pointer-events: none` (neither selectable nor draggable), so the button opts back in */}
      <button type="button" className="nodrag nopan btn btn-xs btn-soft pointer-events-auto rounded-full" disabled={!data.expandable}
              title={data.expandable ? `${data.hiddenCount} related notes not shown: show them` : `${data.hiddenCount} related notes not shown (the graph's limits)`}
              onClick={() => data.onExpand(data.key)}>
        {data.hiddenCount}
      </button>
    </>
  );
});
