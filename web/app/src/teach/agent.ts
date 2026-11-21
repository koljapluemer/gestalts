import { INSTALL_BRIDGE, bridgeBackend, httpBackend, type AgentBackend } from '@gestalts/workshop';
import { AGENT_NODE } from '../nodes';

/**
 * Who works on a lesson with the teacher: the server's agent (on our API key, within the school's budget), or the
 * claude CLI on this computer, through the claude bridge (`mise run claude-bridge`). Kept in this
 * browser, since the CLI is this computer's.
 */
export type AgentChoice = { agent: 'server' | 'cli'; node: string };

const KEY = 'teacher:agent';
export const DEFAULT_NODE: string = AGENT_NODE;
export const START = INSTALL_BRIDGE;

export function loadChoice(): AgentChoice {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<AgentChoice> | null;
    if (v && (v.agent === 'server' || v.agent === 'cli')) return { agent: v.agent, node: typeof v.node === 'string' && v.node ? v.node : DEFAULT_NODE };
  } catch { /* the default */ }
  return { agent: 'server', node: DEFAULT_NODE };
}

export function saveChoice(c: AgentChoice) {
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* for this visit only */ }
}

/** An http(s) address without a path, or why not. */
export function nodeProblem(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'an http:// address';
    if (u.pathname !== '/' || u.search || u.hash) return 'the bridge’s address only, like http://127.0.0.1:7737';
  } catch {
    return 'an address like http://127.0.0.1:7737';
  }
  return undefined;
}

/**
 * What the CLI is told before the workshop's contract, as the server's agent is (`PREFACE` in
 * `web/server/src/agent.rs`, less what is about its tools).
 */
const BRIEF = `\
You are making an interactive learning view for a teacher, for their class. When it's done they publish it, and \
their students open it on school devices (old iPads and Chromebooks among them): keep it light, and make it work \
well with touch and on a small screen. A published view reaches no server: no fetch, no external images or fonts; \
npm packages are bundled and pinned. Speak to the teacher plainly, in the language they write in; they are not \
programmers.`;

export function cliAgent(node: string): AgentBackend {
  return bridgeBackend(node, { brief: BRIEF });
}

export function backendFor(choice: AgentChoice, draft: string): AgentBackend {
  return choice.agent === 'cli'
    ? cliAgent(choice.node)
    : httpBackend(`/api/drafts/${draft}/agent`, { id: 'teacher-server', label: 'Claude' });
}
