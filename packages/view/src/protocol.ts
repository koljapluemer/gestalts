import type { Delta, Item, Json, JsonMap, Page, Query } from './types';

/** Bumped when a message below changes meaning. A view and the host that run it must agree. */
export const PROTOCOL = 1;

/** What a view is told when it starts. */
export type ViewInit = {
  protocol: number;
  id: string;
  title: string;
  /** set by whoever opened it */
  params: Record<string, string>;
  /** what it last saved with `useViewState` */
  state: JsonMap;
};

export type ServiceReply = { status: number; contentType: string; body: Uint8Array };

/** HTTP through the app, to a host the view's manifest lists in `network`. */
export type NetRequest = { url: string; method?: string; headers?: Record<string, string>; body?: string | Uint8Array };
/** The remote's answer, whatever its status. A refusal by the app is an error instead. */
export type NetReply = ServiceReply;

/** A completion from the user's LLM providers; with `json`, the answer is a JSON text. */
export type LlmRequest = { prompt: string; json?: boolean };
export type LlmReply = { text: string; provider: string; model: string };

/** What the view can use here and now: a manifest asks, but the app around it decides. */
export type Capabilities = { net: boolean; llm: boolean };

/** Everything a view can ask of its host. The host checks each against the view's `reads` and `writes`. */
export type Call =
  | { op: 'query'; query: Query }
  | { op: 'subscribe'; query: Query }
  | { op: 'unsubscribe'; sub: number }
  | { op: 'put'; value: JsonMap }
  | { op: 'delete'; id: string }
  | { op: 'readBlob'; name: string }
  | { op: 'writeBlob'; name: string; bytes: Uint8Array }
  | { op: 'stableId'; namespace: string; name: string }
  | { op: 'stateId'; gestalt: string; target: string; facet?: string }
  | { op: 'contentHash'; bytes: Uint8Array }
  | { op: 'service'; path: string; method: string; body?: string | Uint8Array; contentType?: string }
  | { op: 'net'; request: NetRequest }
  | { op: 'llm'; request: LlmRequest }
  | { op: 'capabilities' }
  | { op: 'setState'; state: JsonMap }
  | { op: 'setTitle'; title: string }
  | { op: 'openView'; view: string; params?: Record<string, string> };

/** What each call answers. */
export type Answers = {
  query: Page;
  subscribe: { sub: number; page: Page };
  unsubscribe: null;
  put: Item;
  delete: boolean;
  readBlob: Uint8Array | null;
  writeBlob: null;
  stableId: string;
  stateId: string;
  contentHash: string;
  service: ServiceReply;
  net: NetReply;
  llm: LlmReply;
  capabilities: Capabilities;
  setState: null;
  setTitle: null;
  openView: null;
};

export type ViewError = { kind: 'error' | 'rejection' | 'render' | 'console' | 'compile'; message: string; stack?: string; at: string };

export type FromView =
  | { type: 'call'; id: number; call: Call }
  | { type: 'error'; error: ViewError }
  /** how far the frame has got starting the view, for the log */
  | { type: 'stage'; stage: string };

export type ToView =
  | { type: 'reply'; id: number; ok: true; value: Json | Uint8Array | object }
  | { type: 'reply'; id: number; ok: false; error: string }
  | { type: 'delta'; delta: Delta };
