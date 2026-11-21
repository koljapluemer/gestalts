import type { ViewError } from '@gestalts/view';

/**
 * What a workshop asks of an agent, whatever runs it (the claude CLI through the Claude bridge, the teacher app's server).
 * The agent sees a draft as files ([`filesOf`](../draft.ts)) and returns the files it changed; the browser turns them
 * into ymls and writes them, so no agent needs access to any.
 */
export type TurnRequest = {
  /** the view's id (lowercase letters, digits and -) */
  view: string;
  /** this backend's conversation to continue, from an earlier `done` */
  session?: string;
  message: string;
  /** the draft as files, by path: `view.tsx`, `view.json`, `gestalts/<name>@<N>.yml`, `data/<id>.yml` */
  files: Record<string, string>;
  /** the gestalts the app has (`name@N`), which the view may read and write besides its own */
  gestalts: string[];
  /** what the preview reported since the last turn, and what couldn't be saved of the last one */
  diagnostics: Diagnostic[];
  /** what the app tells the agent about who it makes views for, before the contract (the local CLI's; a server has its own) */
  brief?: string;
};

/** An error from the preview, or a file of the last turn the repo refused (`save`). */
export type Diagnostic = { kind: ViewError['kind'] | 'save'; message: string; stack?: string; at: string };

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; summary: string }
  /** the files the turn changed; `null`: deleted */
  | { type: 'files'; files: Record<string, string | null> }
  | { type: 'done'; session?: string }
  | { type: 'error'; message: string };

export interface AgentBackend {
  /** recorded with its sessions, so it stays */
  id: string;
  label: string;
  /** whether it can take a turn now, else why not */
  available(): Promise<true | string>;
  /** when it isn't available until the person allows this site (the Claude bridge): asks, true when allowed */
  connect?(): Promise<true | string>;
  turn(req: TurnRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
}
