import type { AgentTool } from './tools';
import { viewCheckTool } from './tools';
import { viewTemplate } from './template';
import type { AgentBackend, AgentEvent, TurnRequest } from './types';

/**
 * The claude CLI on this computer, through the Claude bridge (`installables/claude-bridge`): a site the person allowed
 * sends the files, the instructions and its tools; the bridge runs `claude -p` on them and hands every tool call back
 * here. This page answers them, so the tools are the app's whatever model runs.
 */

export type BridgeStatus = { app: string; version: string; claude: { found: boolean; path?: string; version?: string }; paired: boolean };

/** One turn, as the bridge takes it. */
export type BridgeStart = {
  /** the workspace's name (a draft's id): a session resumes only in its own */
  workspace: string;
  session?: string;
  prompt: string;
  system?: string;
  files: Record<string, string>;
  /** bytes, as base64 */
  binary?: Record<string, string>;
  /** which paths are the draft (a regex for the whole path): what tools see and what comes back */
  keep: string;
  model?: string;
  maxBudgetUsd?: number;
};

export type BridgeEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; summary: string }
  /** the draft's files the turn changed; `null`: deleted */
  | { type: 'files'; files: Record<string, string | null> }
  | { type: 'done'; session?: string }
  | { type: 'error'; message: string };

export const INSTALL_BRIDGE = 'Install the Claude bridge and Claude Code on this computer, then start the bridge';

const tokenKey = (url: string) => `claude-bridge:token:${url.replace(/\/+$/, '')}`;
function token(url: string): string | undefined {
  try { return localStorage.getItem(tokenKey(url)) ?? undefined; } catch { return undefined; }
}

const base = (url: string) => url.replace(/\/+$/, '');

/** What the bridge at `url` says, or why there's no answer. */
export async function bridgeStatus(url: string): Promise<BridgeStatus | string> {
  try {
    const t = token(url);
    const r = await fetch(`${base(url)}/status`, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
    if (!r.ok) return `the Claude bridge at ${base(url)} answered ${r.status}`;
    return (await r.json()) as BridgeStatus;
  } catch {
    return `no Claude bridge answers at ${base(url)}. ${INSTALL_BRIDGE}.`;
  }
}

/** Asks the bridge to let this site use it; the person decides in a dialog on their computer. */
export async function pairBridge(url: string): Promise<true | string> {
  try {
    const r = await fetch(`${base(url)}/pair`, { method: 'POST' });
    const body = (await r.json().catch(() => ({}))) as { token?: string; error?: string };
    if (!r.ok || !body.token) return body.error ?? `the Claude bridge answered ${r.status}`;
    try { localStorage.setItem(tokenKey(url), body.token); } catch { return 'this browser keeps nothing: allow storage for this site'; }
    return true;
  } catch {
    return `no Claude bridge answers at ${base(url)}`;
  }
}

/** Whether a turn can run now, else why not. */
export async function bridgeAvailable(url: string): Promise<true | string> {
  const s = await bridgeStatus(url);
  if (typeof s === 'string') return s;
  if (!s.claude.found) return 'the Claude bridge runs, but finds no Claude Code on this computer: install it and sign in once in a terminal';
  if (!s.paired) return 'not connected to the Claude bridge yet';
  return true;
}

/**
 * Runs one turn on the bridge at `url`, answering its tool calls with `tools`. Aborting `signal` stops claude; what
 * it changed until then still comes back.
 */
export async function* runOnBridge(url: string, start: BridgeStart, tools: AgentTool[], signal: AbortSignal): AsyncIterable<BridgeEvent> {
  const t = token(url);
  const ws = new WebSocket(`${base(url).replace(/^http/, 'ws')}/runs${t ? `?token=${encodeURIComponent(t)}` : ''}`);
  const queue: BridgeEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const push = (e: BridgeEvent) => { queue.push(e); wake?.(); };
  const byName = new Map(tools.map((x) => [x.name, x]));

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'start', ...start, tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));
  });
  ws.addEventListener('message', (m) => {
    let e: { type: string; id?: string; name?: string; input?: unknown; files?: Record<string, string> };
    try { e = JSON.parse(String(m.data)); } catch { return; }
    if (e.type === 'tool_call') {
      const tool = byName.get(e.name ?? '');
      const answer = tool
        ? tool.run(e.input, e.files ?? {})
        : Promise.resolve({ content: [{ type: 'text' as const, text: `no tool ${e.name}` }], isError: true });
      void answer.then((r) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'tool_result', id: e.id, ...r })); });
    } else {
      push(e as BridgeEvent);
    }
  });
  ws.addEventListener('close', () => { closed = true; wake?.(); });
  ws.addEventListener('error', () => {
    if (queue.length === 0) push({ type: 'error', message: `cannot reach the Claude bridge at ${base(url)}, or it doesn't allow this site` });
  });
  const cancel = () => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'cancel' })); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      while (queue.length) {
        const e = queue.shift()!;
        yield e;
        if (e.type === 'done') return;
      }
      if (closed) {
        yield { type: 'done' };
        return;
      }
      await new Promise<void>((r) => { wake = r; });
      wake = undefined;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }
}

/** What a draft is, as files; everything else in a workspace is the template's or scratch. */
export const VIEW_FILES = String.raw`view\.tsx|view\.json|gestalts/[a-z0-9-]+@[1-9][0-9]*\.yml|data/[^/\\.][^/\\]{0,199}\.yml`;
const SYSTEM = 'You are editing one view in this directory. CLAUDE.md here is the contract: read it first. Only view.tsx, view.json, gestalts/ and data/ are kept; run the check tool before you finish.';

function errorsFile(diagnostics: TurnRequest['diagnostics']): string {
  const lines = ['# Errors the preview reported since the last turn', ''];
  for (const d of diagnostics) lines.push(`## ${d.kind}: ${d.message}`, '', '```', (d.stack ?? '').trim(), '```', '');
  return lines.join('\n');
}

/**
 * A draft view's agent: the claude CLI through the bridge at `url`, with the workshop's check. `brief` goes before
 * the contract: who the app makes views for. `connect` asks the bridge to allow this site.
 */
export function bridgeBackend(url: string, opts: { brief?: string } = {}): AgentBackend & { connect(): Promise<true | string> } {
  return {
    id: 'claude-cli',
    label: 'Claude (Claude Code on this computer)',
    available: () => bridgeAvailable(url),
    connect: () => pairBridge(url),
    async *turn(req: TurnRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
      const files: Record<string, string> = { ...(await viewTemplate()), ...req.files };
      let prompt = req.message;
      if (req.diagnostics.length) {
        files['runtime-errors.md'] = errorsFile(req.diagnostics);
        prompt += `\n\n(The preview reported ${req.diagnostics.length} error(s) since the last turn: see runtime-errors.md.)`;
      }
      const brief = req.brief ?? opts.brief;
      const start: BridgeStart = {
        workspace: req.view, session: req.session, prompt, files, keep: VIEW_FILES,
        system: brief ? `${brief}\n\n${SYSTEM}` : SYSTEM,
      };
      yield* runOnBridge(url, start, [viewCheckTool(req.gestalts)], signal);
    },
  };
}
