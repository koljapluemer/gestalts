import { createContext, createElement, useContext, type ComponentType, type ReactNode } from 'react';
import type { Query } from './types';

/** A new note the user may still edit before creating it. */
export type NoteDraft = { title?: string; tags?: string[] };

/** A slot view: a plugin's view of one gestalt, in a place the host owns (a note's view, a canvas node). */
export type SlotProps = { noteKey: string };

/**
 * What a perspective may ask of the host. Every capability is optional: a perspective hides the UI for one the host
 * doesn't offer (no open buttons without `openNote`).
 */
export type Host = {
  /** show a note (the host's editor) */
  openNote?: (key: string) => void;
  /** offer the new-note form; resolves to the created note's key, or null when cancelled */
  createNote?: (draft?: NoteDraft) => void;
  /** let the user pick a note matching `query`; null when cancelled */
  pickNote?: (query: Query, title?: string) => Promise<string | null>;
  /** open a pane (`<plugin>/<pane>`), with params */
  navigate?: (pane: string, params?: Record<string, string>) => void;
  /** the title of the pane this perspective is in */
  setTitle?: (title: string) => void;
  /** the view a plugin registered for `name` and `gestalt`, if any */
  slot?: (name: string, gestalt: string) => ComponentType<SlotProps> | undefined;
};

const HostContext = createContext<Host>({});

export function HostProvider({ host, children }: { host: Host; children: ReactNode }) {
  return <HostContext value={host}>{children}</HostContext>;
}

/** The host's capabilities, as far as this place in the app offers them. */
export function useHost(): Host {
  return useContext(HostContext);
}

/**
 * A slot: the view a plugin registered for `name` and `gestalt`, or `fallback` (nothing by default). Plugins compose
 * with each other this way, never by importing each other.
 */
export function Slot({ name, gestalt, noteKey, fallback = null }: { name: string; gestalt: string; noteKey: string; fallback?: ReactNode }) {
  const view = useHost().slot?.(name, gestalt);
  return view ? createElement(view, { noteKey }) : <>{fallback}</>;
}
