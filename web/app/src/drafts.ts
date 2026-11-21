import { useEffect } from 'react';
import { registry } from 'virtual:gestalts-plugins/workshop';
import type { Repo } from '@gestalts/client';
import { usePluginRepo } from '@gestalts/host';
import { AGENT_NODE } from './nodes';

/**
 * The workshops' drafts (learning views and vizzes): in this browser. Each agent turn sends a draft's files, so the
 * agents need no copy; syncing with folder-sync is the person's choice (settings).
 */
export function useDrafts(): { repo?: Repo; error?: string } {
  const { repo, error } = usePluginRepo({ dir: 'drafts' }, registry);
  useEffect(() => {
    // drafts used to sync with the node that ran the agents, where the Claude bridge now is: it doesn't sync
    if (repo && repo.connector.get().url?.replace(/\/+$/, '') === AGENT_NODE.replace(/\/+$/, '')) repo.disconnect();
  }, [repo]);
  return { repo, error };
}
