import type { Repo } from '@gestalts/client';

const SERVICE = 'vizint-agent';

export type BuildRequest = {
  viz: string; title: string; spec: string; source?: string; packages: string[];
  /** by label, as base64 */
  files: Record<string, string>;
};

export type BuildEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'error'; message: string }
  /** the end of a build: what it made; `built` and `still` (base64) only when the check passed */
  | { type: 'result'; ok: boolean; check: string; generator: string; source: string | null; packages: string[]; built?: string; still?: string }
  | { type: 'done' };

/** Whether the node this page syncs with offers the agent, else why not. */
export async function available(repo: Repo): Promise<true | string> {
  const services = await repo.services();
  if (!services) return 'not connected to a node (settings)';
  const s = services.find((x) => x.id === SERVICE);
  if (!s) return `the node offers no ${SERVICE}: start it with mise run vizint-workshop:node`;
  if (!s.available) return `${SERVICE} isn't running (yet): see the node's log`;
  return true;
}

/**
 * One build by the claude CLI, through the `vizint-agent` backend on the node: a cancellable job read through short
 * event polls, so no request has to last as long as the build.
 */
export async function* build(repo: Repo, req: BuildRequest, signal: AbortSignal): AsyncIterable<BuildEvent> {
  const call = (path: string, init?: RequestInit) => repo.service(SERVICE, path, init) ?? Promise.reject(new Error('not connected to a node'));
  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const started = await call('build', json(req));
  const body = (await started.json().catch(() => ({}))) as { job?: string; error?: string };
  if (!started.ok || !body.job) { yield { type: 'error', message: body.error ?? `${SERVICE} answered ${started.status}` }; return; }
  const job = body.job;
  const cancel = () => { void call('cancel', json({ job })); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    let after = 0;
    for (;;) {
      let r: Response;
      try {
        r = await call(`events?job=${job}&after=${after}`);
      } catch {
        // a dropped poll is retried; the build goes on meanwhile
        if (signal.aborted) return;
        await new Promise((res) => setTimeout(res, 1000));
        continue;
      }
      const page = (await r.json().catch(() => ({}))) as { events?: BuildEvent[]; next?: number; done?: boolean; error?: string };
      if (!r.ok) { yield { type: 'error', message: page.error ?? `${SERVICE} answered ${r.status}` }; return; }
      for (const e of page.events ?? []) yield e;
      after = page.next ?? after;
      if (page.done) return;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
