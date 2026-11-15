import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { select } from 'd3-selection';
import 'd3-transition';
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior } from 'd3-zoom';

/** Where a pan/zoom is: content point `p` shows at `k·p + (x, y)`. */
export type PanZoomTransform = { k: number; x: number; y: number };

export type PanZoom = {
  /** a callback ref for the element that takes the gestures (an `<svg>` or any element) */
  attach: (el: Element | null) => void;
  /** how far it may zoom (`[min, max]`) and the content box it may pan within (`[[x0, y0], [x1, y1]]`) */
  setExtent(scale: [number, number], translate: [[number, number], [number, number]]): void;
  /** to `t`, over `ms` (at once without) */
  transformTo(t: PanZoomTransform, ms?: number): void;
  /** zooms by `factor` around the middle, over `ms` */
  scaleBy(factor: number, ms?: number): void;
};

/**
 * Pan and zoom by drag, wheel and pinch (d3-zoom), reported to `onZoom` on every change, whether by a gesture or by
 * `transformTo`/`scaleBy`: that is the one place the transform comes from. Applying it is up to the caller (a group's
 * `transform`, say). Double-click doesn't zoom. `clickDistance`: how far a pointer may move between down and up and
 * still be a click, not a drag (px).
 */
export function usePanZoom(onZoom: (t: PanZoomTransform) => void, { clickDistance = 0 }: { clickDistance?: number } = {}): PanZoom {
  const report = useRef(onZoom);
  useLayoutEffect(() => { report.current = onZoom; }, [onZoom]);
  const el = useRef<Element | null>(null);
  const behavior = useRef<ZoomBehavior<Element, unknown> | null>(null);

  const attach = useCallback((node: Element | null) => {
    if (el.current && behavior.current) select(el.current).on('.zoom', null);
    el.current = node;
    behavior.current = null;
    if (!node) return;
    const z = zoom<Element, unknown>()
      .clickDistance(clickDistance)
      .on('zoom', (e: D3ZoomEvent<Element, unknown>) => report.current({ k: e.transform.k, x: e.transform.x, y: e.transform.y }));
    select(node).call(z).on('dblclick.zoom', null);
    behavior.current = z;
  }, [clickDistance]);

  return useMemo(() => ({
    attach,
    setExtent: (scale, translate) => { behavior.current?.scaleExtent(scale).translateExtent(translate); },
    transformTo: (t, ms) => {
      const z = behavior.current;
      if (!el.current || !z) return;
      const target = zoomIdentity.translate(t.x, t.y).scale(t.k);
      if (ms) select(el.current).transition().duration(ms).call(z.transform, target);
      else select(el.current).call(z.transform, target);
    },
    scaleBy: (factor, ms) => {
      const z = behavior.current;
      if (!el.current || !z) return;
      if (ms) select(el.current).transition().duration(ms).call(z.scaleBy, factor);
      else select(el.current).call(z.scaleBy, factor);
    },
  }), [attach]);
}
