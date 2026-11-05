/**
 * The Tauri app around the page (the Gestalter on Android): its commands and events, as the `NativeHost` the repo
 * opens with, plus pairing for the app's settings. The Rust side is `gestalts_device`, behind the app's commands of
 * the same names (see the Gestalter's `doc/android.md`).
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { NativeHost, NativeStatus, PairedNodeInfo } from './native';

export const CHANGED_EVENT = 'gestalts://changed';
export const STATUS_EVENT = 'gestalts://status';

/** Whether the page runs inside a Tauri app. */
export function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** A blob comes back with a first byte telling whether it exists (1) or not (0), so an empty blob isn't missing. */
function blob(buf: ArrayBuffer): Uint8Array | null {
  const bytes = new Uint8Array(buf);
  return bytes[0] === 1 ? bytes.subarray(1) : null;
}

let host: NativeHost | undefined;

export function tauriHost(): NativeHost {
  host ??= {
    listNotes: () => invoke('notes_list'),
    readNote: (key) => invoke('note_read', { key }),
    readNotes: (keys) => invoke('notes_read', { keys }),
    readAllNotes: () => invoke('notes_read_all'),
    noteHashes: () => invoke('notes_hashes'),
    writeNote: (key, text) => invoke('note_write', { key, text }),
    writeNotes: (notes) => invoke('notes_write', { notes }),
    deleteNote: (key) => invoke('note_delete', { key }),
    listBlobs: () => invoke('blobs_list'),
    readBlob: async (name) => blob(await invoke<ArrayBuffer>('blob_read', { name })),
    writeBlob: (name, bytes) => invoke('blob_write', bytes, { headers: { 'x-blob-name': encodeURIComponent(name) } }),
    deleteBlob: (name) => invoke('blob_delete', { name }),
    setGestalts: (yaml) => invoke('gestalts_set', { yaml }),
    status: () => invoke('sync_status'),
    onChanged: (f) => listen<{ notes: string[]; blobs: string[] }>(CHANGED_EVENT, (e) => f(e.payload)),
    onStatus: (f) => listen<NativeStatus>(STATUS_EVENT, (e) => f(e.payload)),
    sync: () => invoke('sync_now'),
    setActive: (active) => invoke('set_active', { active }),
  };
  return host;
}

/**
 * Pairs the app with the computer whose pairing code (`gestalts-pair:…`, its QR code) this is, then syncs. The
 * computer lists this device as `deviceName`, by default the phone's model.
 */
export function pair(uri: string, deviceName?: string): Promise<PairedNodeInfo> {
  return invoke('pair', { uri, deviceName });
}

/** Forgets the paired computer on this device; the notes stay. */
export function forget(): Promise<void> {
  return invoke('forget');
}
