import type { Repo, ServiceStatus } from '@gestalts/client';
import { jobBackend } from './jobs';
import type { AgentBackend } from './types';

/** The node plugin that runs the claude CLI on a draft's files (`installables/claude-bridge/plugins/workshop-agent`). */
export const AGENT_SERVICE = 'workshop-agent';

/** How a page reaches a node's plugin backends, and what to say when it can't. */
export type NodeServices = {
  call(service: string, path: string, init?: RequestInit): Promise<Response> | undefined;
  /** the node's services, null when there's no node or it didn't answer */
  list(): Promise<ServiceStatus[] | null>;
  /** why `list` came back null */
  missing: string;
  /** how to start a node that has the agent */
  start: string;
};

/** Through the node a repo syncs with. */
export function repoNode(repo: Repo, start: string): NodeServices {
  return {
    call: (service, path, init) => repo.service(service, path, init),
    list: () => repo.services(),
    missing: 'not connected to a node (settings)',
    start,
  };
}

/** A node at `url` that the page doesn't sync with; it must allow this page's origin. */
export function nodeAt(url: string, start: string): NodeServices {
  const base = url.replace(/\/+$/, '');
  return {
    call: (service, path, init) => fetch(`${base}/services/${encodeURIComponent(service)}/${path.replace(/^\//, '')}`, init),
    async list() {
      try {
        const r = await fetch(`${base}/services`);
        return r.ok ? ((await r.json()) as ServiceStatus[]) : null;
      } catch {
        return null;
      }
    },
    missing: `no node answers at ${base}, or it doesn't allow ${location.origin}`,
    start,
  };
}

/**
 * The claude CLI on this computer, through the `workshop-agent` backend on a node. `brief` goes before the agent's
 * contract: who the app makes views for.
 */
export function cliBackend(node: NodeServices, opts: { brief?: string } = {}): AgentBackend {
  const backend = jobBackend({
    id: 'claude-cli',
    label: 'Claude (local CLI)',
    call: (path, init) => node.call(AGENT_SERVICE, path, init) ?? Promise.reject(new Error(node.missing)),
    async available() {
      const services = await node.list();
      if (!services) return node.missing;
      const s = services.find((x) => x.id === AGENT_SERVICE);
      if (!s) return `the node offers no ${AGENT_SERVICE}: start one with ${node.start}`;
      if (!s.available) return `${AGENT_SERVICE} isn't running (yet): see the node's log`;
      return true;
    },
  });
  const { brief } = opts;
  return brief ? { ...backend, turn: (req, signal) => backend.turn({ ...req, brief }, signal) } : backend;
}
