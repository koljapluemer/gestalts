import type { ServiceClient } from '@gestalts/sdk';

/**
 * The `ollama@1` service (the `ollama` plugin's worker): local language models on the node's computer. A perspective
 * declares it optionally (`services: { llm: OLLAMA_SERVICE }`) and works without it, as there's none on a phone or in
 * a browser without the node.
 */
export const OLLAMA_SERVICE = 'ollama@1';

/** A model's download, as far as it got: `status` is "success" when done, `error` set when it failed. */
export type Pull = { status: string; completed: number; total: number; error: string | null };

/** Every failure: no service, no server, no model (`missingModel`), or a reply that isn't one. */
export class LlmUnavailable extends Error {
  constructor(message: string, readonly missingModel: string | null = null) {
    super(message);
  }
}

async function call<T>(llm: ServiceClient | undefined, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (!llm) throw new LlmUnavailable('no node with the Ollama plugin');
  let r: Response;
  try {
    r = await llm.request(path, body === undefined ? { signal } : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new LlmUnavailable(e instanceof Error ? e.message : String(e));
  }
  const text = await r.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON: the node's own error text */ }
  const reply = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  if (!r.ok) {
    const message = typeof reply.error === 'string' ? reply.error : text || `${r.status} ${r.statusText}`;
    throw new LlmUnavailable(r.status === 503 && !text ? 'the Ollama plugin is starting or not running' : message,
      typeof reply.missing_model === 'string' ? reply.missing_model : null);
  }
  return reply as T;
}

/** The installed models. */
export const ollamaModels = async (llm: ServiceClient | undefined) => (await call<{ models: string[] }>(llm, 'models')).models;

/** The model's reply. `schema` asks for JSON of that shape, but not every model keeps to it: parse leniently. */
export const ollamaChat = async (llm: ServiceClient | undefined, req: { model: string; system: string; user: string; schema?: unknown }, signal?: AbortSignal) =>
  (await call<{ content: string }>(llm, 'chat', req, signal)).content;

/** Starts downloading the model, unless that's under way. */
export const ollamaPull = async (llm: ServiceClient | undefined, model: string) => (await call<{ pull: Pull | null }>(llm, 'pull', { model })).pull;

/** The worker's download of the model, if any. */
export const ollamaPullStatus = async (llm: ServiceClient | undefined, model: string) =>
  (await call<{ pull: Pull | null }>(llm, `pull?${new URLSearchParams({ model })}`)).pull;

export const pullRunning = (p: Pull | null | undefined) => !!p && !p.error && p.status !== 'success';
