/**
 * The gestalts-node on this computer (folder-sync), asked for plugin backends, `/net` and `/llm` beside the home
 * store, which it doesn't hold: the notes stay in this browser.
 */
export const HOME_NODE: string = import.meta.env.VITE_GESTALTS_NODE ?? 'http://127.0.0.1:7717';

/** The Claude bridge on this computer (`installables/claude-bridge`), which runs the agents: Claude Code, with this app's tools. */
export const AGENT_NODE: string = import.meta.env.VITE_AGENT_NODE ?? 'http://127.0.0.1:7737';
