import { useEffect } from 'react';
import { registry } from 'virtual:gestalts-plugins/workshop';
import type { Repo } from '@gestalts/client';
import { usePluginRepo } from '@gestalts/host';
import { AGENT_NODE } from './nodes';

const CONNECTED_ONCE = 'drafts:connected-once';

/**
 * The workshops' drafts (learning views and vizzes): in this browser, synced with the node that runs the agents, which
 * works on them in its folder. Connected the first time only: a later Disconnect is the user's choice.
 */
export function useDrafts(): { repo?: Repo; error?: string } {
  const { repo, error } = usePluginRepo({ dir: 'drafts' }, registry);
  useEffect(() => {
    if (!repo || repo.connector.get().url) return;
    try {
      if (localStorage.getItem(CONNECTED_ONCE)) return;
      localStorage.setItem(CONNECTED_ONCE, '1');
    } catch { /* not remembered: connect each time */ }
    void repo.connect(AGENT_NODE);
  }, [repo]);
  return { repo, error };
}
