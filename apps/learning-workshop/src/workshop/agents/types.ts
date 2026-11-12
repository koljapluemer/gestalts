import type { ViewError } from '@gestalts/view';

/**
 * What the workshop asks of an agent, whatever runs it (the claude CLI behind the node now; an API called from the
 * browser later). The agent sees a view as files and returns the files it changed; the browser checks them and
 * writes the yml, so no agent needs access to any.
 */
export type TurnRequest = {
  /** the view's id (lowercase letters, digits and -) */
  view: string;
  /** this backend's conversation to continue, from an earlier `done` */
  session?: string;
  message: string;
  /** `view.tsx` and `view.json`, by path */
  files: Record<string, string>;
  /** what the preview reported since the last turn */
  diagnostics: ViewError[];
};

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
  turn(req: TurnRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
}
