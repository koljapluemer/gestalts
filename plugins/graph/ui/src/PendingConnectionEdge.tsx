import { useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useInternalNode, type EdgeProps } from '@xyflow/react';
import { X } from 'lucide-react';
import { UNLABELLED } from './graph';
import { EDGE_OVERLAY_Z_INDEX, getEdgeParams } from './geometry';

export type PendingConnectionEdgeData = {
  /** an empty label makes it unlabelled */
  onConfirm: (label: string | null) => Promise<void>;
  onCancel: () => void;
};

/** A relationship dragged from one card onto another, asking for its label before it's written. */
export function PendingConnectionEdge({ source, target, data }: EdgeProps) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!sourceNode?.measured.width || !targetNode?.measured.width) return null;

  const { onConfirm, onCancel } = (data ?? {}) as Partial<PendingConnectionEdgeData>;
  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(sourceNode, targetNode);
  const [path, labelX, labelY] = getBezierPath({
    sourceX: sx, sourceY: sy, sourcePosition: sourcePos, targetX: tx, targetY: ty, targetPosition: targetPos, curvature: 0.32,
  });

  const confirm = async () => {
    if (!onConfirm || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(label.trim() || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <>
      <BaseEdge path={path} style={{ strokeWidth: 1.6, strokeDasharray: '4 4' }} />
      <EdgeLabelRenderer>
        <div className="nodrag nopan" style={{
          position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'all', zIndex: EDGE_OVERLAY_Z_INDEX,
        }}>
          <form className="flex flex-col gap-1.5 rounded-box border border-base-300 bg-base-100 p-2 shadow-lg"
                onSubmit={(e) => { e.preventDefault(); void confirm(); }}>
            <div className="flex items-center gap-1.5">
              <input
                // oxlint-disable-next-line jsx-a11y/no-autofocus -- the label is what's asked for
                autoFocus
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onCancel?.(); }}
                placeholder={UNLABELLED}
                className="input input-xs w-32 rounded-full"
              />
              <button type="submit" className="btn btn-primary btn-xs" disabled={busy}>Relate</button>
              <button type="button" className="btn btn-ghost btn-xs btn-square" title="Cancel" onClick={() => onCancel?.()}><X className="size-3.5" /></button>
            </div>
            {error && <p role="alert" className="text-xs text-error">{error}</p>}
          </form>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
