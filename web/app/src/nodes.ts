/**
 * The gestalts-node on this computer (the desktop app), asked for plugin backends, `/net` and `/llm` beside the home
 * store, which it doesn't hold: the notes stay in this browser.
 */
export const HOME_NODE: string = import.meta.env.VITE_GESTALTS_NODE ?? 'http://127.0.0.1:7717';

/**
 * The claude bridge, which runs the agents (the claude CLI; `mise run claude-bridge`): the workshops' drafts sync with it, and the
 * teacher's CLI agent runs on it.
 */
export const AGENT_NODE: string = import.meta.env.VITE_AGENT_NODE ?? 'http://127.0.0.1:7737';
export const START_AGENT_NODE = 'mise run claude-bridge';
