/**
 * The node this page is served by, through its `/control/*`: same-origin, so no token is needed.
 */
import type { LlmSettings, LlmSettingsChange } from '@gestalts/client';

export type PluginStatus = { id: string; version: string; state: 'stopped' | 'starting' | 'ready' | 'running' | 'error'; error?: string | null };

export type NodeStatus = {
  version: string;
  address: string;
  folder: { id: string; path: string } | null;
  clients: { origin: string; seconds_ago: number }[];
  plugins: PluginStatus[];
  uv: { state: 'locating' | 'downloading' } | { state: 'ready'; version: string } | { state: 'failed'; error: string };
  /** null: starting on login isn't available */
  autostart: boolean | null;
  /** the home network; null if this node doesn't pair with devices */
  lan: LanStatus | null;
  devices: PairedDevice[];
};

export type LanStatus = {
  /** only while a device is paired, or a pairing code is shown */
  listening: boolean;
  port: number;
  /** `ip:port` devices reach this computer at */
  addresses: string[];
  node_id: string;
  pairing_open: boolean;
};

export type PairedDevice = { id: string; name: string; paired_at: string; last_seen: string | null };

/** A pairing code: the QR code a device scans, valid for `expires_in` seconds. */
export type PairingOffer = { uri: string; svg: string; addresses: string[]; expires_in: number };


async function control<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`control/${path}`, init);
  if (!r.ok) throw new Error((await r.text()) || `${r.status} ${r.statusText}`);
  return (r.status === 204 ? undefined : await r.json()) as T;
}

const json = (body: unknown): RequestInit => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const node = {
  status: () => control<NodeStatus>('status'),
  /** the native folder picker; the status afterwards, whether or not one was picked */
  chooseFolder: () => control<NodeStatus>('choose-folder', { method: 'POST' }),
  reveal: () => control<void>('reveal', { method: 'POST' }),
  setAutostart: (on: boolean) => control<NodeStatus>('autostart', json({ on })),
  quit: () => control<void>('quit', { method: 'POST' }),
  /** shows a pairing code, and listens on the home network until it's used or expires */
  startPairing: () => control<PairingOffer>('pairing', { method: 'POST' }),
  cancelPairing: () => control<void>('pairing', { method: 'DELETE' }),
  /** unpairs a device; its access ends at once */
  forgetDevice: (id: string) => control<void>(`devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** the LLM providers views can ask (never their keys) */
  llmSettings: async (): Promise<LlmSettings> => {
    const r = await fetch('llm/settings');
    if (!r.ok) throw new Error((await r.text()) || `${r.status} ${r.statusText}`);
    return (await r.json()) as LlmSettings;
  },
  /** an absent field stays, a `key: null` clears that key */
  changeLlmSettings: (change: LlmSettingsChange) => control<LlmSettings>('llm/settings', json(change)),
};
