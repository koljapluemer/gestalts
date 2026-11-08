import type { HostStorage } from '../wasm/gestalts.js';

/** The node a native app is paired with (`gestalts_device::NodeInfo`). */
export type PairedNodeInfo = { nodeId: string; name: string };

/** How a native app syncs with its paired node (`gestalts_device::Status`). */
export type NativeStatus = {
  paired: PairedNodeInfo | null;
  state: 'off' | 'syncing' | 'ok' | 'error';
  error: string | null;
  /** unix ms of the last sync that worked */
  lastSync: number | null;
  lastReport: unknown;
  /** the folder the node serves, as of the last sync */
  folder: string | null;
  conflicts: string[];
};

/**
 * A native app around the page (Android): it keeps the ymls in its own folder, which the page's core reads and
 * writes through `HostStorage`, and syncs that folder with the node it paired with, telling the page what changed.
 */
export interface NativeHost extends HostStorage {
  /** the plugins' gestalt definitions, which the app's own merges need too */
  setGestalts(yaml: string[]): Promise<void>;
  status(): Promise<NativeStatus>;
  /** Calls `f` with the ymls and blobs a sync changed in the folder; returns a function to stop. */
  onChanged(f: (changed: { ymls: string[]; blobs: string[] }) => void): Promise<() => void>;
  onStatus(f: (status: NativeStatus) => void): Promise<() => void>;
  /** asks for a sync now; the status tells how it goes */
  sync(): Promise<void>;
  /** whether the page is visible: the app syncs on a timer only then */
  setActive(active: boolean): Promise<void>;
}

/** The native apps `YmlsIn` can name. */
export type NativeKind = 'tauri';

export async function nativeHost(kind: NativeKind): Promise<NativeHost> {
  switch (kind) {
    case 'tauri': return (await import('./tauri')).tauriHost();
  }
}
