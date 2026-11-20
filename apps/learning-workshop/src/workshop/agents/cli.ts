import type { Repo } from '@gestalts/client';
import { jobBackend, type AgentBackend } from '@gestalts/workshop';

const SERVICE = 'workshop-agent';

/** The claude CLI on this computer, through the `workshop-agent` backend on the node the page syncs with. */
export function cliBackend(repo: Repo): AgentBackend {
  return jobBackend({
    id: 'claude-cli',
    label: 'Claude (local CLI)',
    call: (path, init) => repo.service(SERVICE, path, init) ?? Promise.reject(new Error('not connected to a node')),
    async available() {
      const services = await repo.services();
      if (!services) return 'not connected to a node (settings)';
      const s = services.find((x) => x.id === SERVICE);
      if (!s) return `the node offers no ${SERVICE}: start it with this repo's plugins (mise run node)`;
      if (!s.available) return `${SERVICE} isn't running (yet): see the node's log`;
      return true;
    },
  });
}
