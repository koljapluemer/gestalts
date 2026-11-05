import { useReactFlow } from '@xyflow/react';
import { useEffect } from 'react';
import type { LayoutCommit } from './useElkLayout';

const FIT_VIEW_OPTIONS = {
  duration: 420,
  maxZoom: 1.15,
  padding: { top: 0.16, right: 0.2, bottom: 0.16, left: 0.2 },
};

/**
 * Frames the canvas whenever a layout commit moved notes. Called straight after
 * the commit: since React Flow 12.5, `fitView` waits for the node update it
 * follows to be applied and measured, so no frame-delay workaround is needed.
 */
export function useFitViewOnReframe(committed: LayoutCommit): void {
  const { fitView } = useReactFlow();

  useEffect(() => {
    if (committed.reframe) {
      void fitView(FIT_VIEW_OPTIONS);
    }
  }, [committed, fitView]);
}
