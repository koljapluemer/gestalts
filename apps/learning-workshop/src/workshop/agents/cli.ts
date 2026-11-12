import type { Repo } from '@gestalts/client';
import type { AgentBackend, AgentEvent, TurnRequest } from './types';

const SERVICE = 'workshop-agent';

/**
 * The claude CLI on this computer, through the `workshop-agent` backend on the node the page syncs with. A turn has no
 * request-sized deadline: it is a cancellable job read through short, independently proxied event polls.
 */
export function cliBackend(repo: Repo): AgentBackend {
  return {
    id: 'claude-cli',
    label: 'Claude (local CLI)',
    async available() {
      const services = await repo.services();
      if (!services) return 'not connected to a node (settings)';
      const s = services.find((x) => x.id === SERVICE);
      if (!s) return `the node offers no ${SERVICE}: start it with this repo's plugins (mise run node)`;
      if (!s.available) return `${SERVICE} isn't running (yet): see the node's log`;
      return true;
    },
    async *turn(req: TurnRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
      const call = (path: string, init?: RequestInit) => repo.service(SERVICE, path, init) ?? Promise.reject(new Error('not connected to a node'));
      const started = await call('turn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
      const body = (await started.json().catch(() => ({}))) as { job?: string; error?: string };
      if (!started.ok || !body.job) { yield { type: 'error', message: body.error ?? `${SERVICE} answered ${started.status}` }; return; }
      const job = body.job;
      const cancel = () => { void call('cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job }) }); };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        let after = 0;
        for (;;) {
          let r: Response;
          try {
            r = await call(`events?job=${job}&after=${after}`);
          } catch (e) {
            // a dropped poll is retried; the job goes on meanwhile
            if (signal.aborted) return;
            await new Promise((res) => setTimeout(res, 1000));
            void e;
            continue;
          }
          const page = (await r.json().catch(() => ({}))) as { events?: AgentEvent[]; next?: number; done?: boolean; error?: string };
          if (!r.ok) { yield { type: 'error', message: page.error ?? `${SERVICE} answered ${r.status}` }; return; }
          for (const e of page.events ?? []) yield e;
          after = page.next ?? after;
          if (page.done) return;
        }
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    },
  };
}
