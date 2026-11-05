import { memo, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useInternalNode, type EdgeProps } from '@xyflow/react';
import { Trash2 } from 'lucide-react';
import { UNLABELLED, type GraphEdge } from './graph';
import { EDGE_OVERLAY_Z_INDEX, getEdgeParams } from './geometry';

export type FloatingEdgeData = {
  relations: GraphEdge[];
  onRelabel?: (relation: GraphEdge, next: string | null) => Promise<void>;
  onDeleteRelation?: (relation: GraphEdge) => Promise<void>;
  onOpenInline?: (relation: GraphEdge) => void;
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A relationship (or a reciprocal pair) between two cards' borders. An explicit one has its label on it, which opens
 * a small form to relabel or remove it; an inline one is dashed and opens its source note, where it's edited.
 * Memoized: a drag re-renders only the edges touching the moved card.
 */
export const FloatingEdge = memo(function FloatingEdge({ id, source, target, style, markerStart, markerEnd, data }: EdgeProps) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const [labels, setLabels] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!sourceNode?.measured.width || !targetNode?.measured.width) return null;

  const { relations = [], onRelabel, onDeleteRelation, onOpenInline } = (data ?? {}) as Partial<FloatingEdgeData>;
  const inline = relations.length > 0 && relations.every((r) => r.inline);
  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(sourceNode, targetNode);
  const [path, labelX, labelY] = getBezierPath({
    sourceX: sx, sourceY: sy, sourcePosition: sourcePos, targetX: tx, targetY: ty, targetPosition: targetPos, curvature: 0.32,
  });

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      setLabels(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const save = () => run(() => Promise.all(relations.map((r, i) => {
    const next = labels?.[i]?.trim() || null;
    return next === r.label || !onRelabel ? Promise.resolve() : onRelabel(r, next);
  })));

  return (
    <>
      <BaseEdge id={id} path={path} style={{ ...style, ...(inline ? { cursor: 'pointer' } : {}) }} markerStart={markerStart} markerEnd={markerEnd}
                interactionWidth={inline ? 20 : 0} onClick={inline && onOpenInline ? () => onOpenInline(relations[0]) : undefined} />
      {relations.length > 0 && !inline && (
        <EdgeLabelRenderer>
          <div className="nodrag nopan" style={{
            position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'all', zIndex: EDGE_OVERLAY_Z_INDEX,
          }}>
            {labels ? (
              <form className="w-60 rounded-box border border-base-300 bg-base-100 p-2.5 shadow-lg"
                    onSubmit={(e) => { e.preventDefault(); void save(); }}>
                {relations.map((r, i) => (
                  <div key={r.id} className="mb-1.5 flex items-center gap-1.5">
                    <input
                      // oxlint-disable-next-line jsx-a11y/no-autofocus -- just opened for editing
                      autoFocus={i === 0}
                      value={labels[i] ?? ''}
                      placeholder={UNLABELLED}
                      title={`${r.source} → ${r.target}`}
                      onChange={(e) => setLabels(labels.map((l, j) => (j === i ? e.target.value : l)))}
                      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') setLabels(null); }}
                      className="input input-xs w-full rounded-full"
                    />
                    <button type="button" className="btn btn-ghost btn-xs btn-square text-error" title="Remove this relationship" disabled={busy || !onDeleteRelation}
                            onClick={() => onDeleteRelation && void run(() => onDeleteRelation(r))}>
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
                {error && <p role="alert" className="mb-1.5 text-xs text-error">{error}</p>}
                <div className="flex justify-end gap-1.5">
                  <button type="button" className="btn btn-ghost btn-xs" onClick={() => setLabels(null)}>Cancel</button>
                  <button type="submit" className="btn btn-primary btn-xs" disabled={busy}>Save</button>
                </div>
              </form>
            ) : (
              <button type="button" title="Relabel or remove"
                      onClick={() => { setError(null); setLabels(relations.map((r) => r.label ?? '')); }}
                      className="rounded-full border border-base-300 bg-base-100/90 px-2 py-0.5 text-xs font-bold text-base-content shadow-sm hover:border-primary/50">
                {relations.map((r) => r.label ?? UNLABELLED).join(' | ')}
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
